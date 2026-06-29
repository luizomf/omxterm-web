import { describe, expect, test } from 'vitest';
import { InMemoryAccessRateLimiter, InMemoryAccessSessionStore, InMemoryDeviceTokenStore, InMemoryTerminalTicketStore, type Clock } from './stores';

function createClock(start = 1_000): Clock & { advance(ms: number): void } {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

const profile = {
  host: 'example.com',
  port: 22,
  username: 'root',
  privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----',
  acceptedHostFingerprint: 'SHA256:test',
};

describe('in-memory stores', () => {
  test('validates sessions by raw token without accepting mismatches', () => {
    const store = new InMemoryAccessSessionStore();
    const { rawSessionToken, session } = store.create();
    expect(store.validate(session.id, rawSessionToken)?.id).toBe(session.id);
    expect(store.validate(session.id, 'wrong')).toBeNull();
  });

  test('expires sessions', () => {
    const clock = createClock();
    const store = new InMemoryAccessSessionStore(clock, 10);
    const { rawSessionToken, session } = store.create();
    clock.advance(11);
    expect(store.validate(session.id, rawSessionToken)).toBeNull();
  });

  test('consumes terminal tickets only once and binds device/session/origin', () => {
    const sessions = new InMemoryAccessSessionStore();
    const devices = new InMemoryDeviceTokenStore();
    const tickets = new InMemoryTerminalTicketStore();
    const { session } = sessions.create();
    const device = devices.create(session.id);
    const issued = tickets.issue({ sessionId: session.id, rawDeviceToken: device.raw, origin: 'https://app.example', profile });

    expect(tickets.consume({ rawTicket: issued.rawTicket, sessionId: session.id, deviceToken: 'bad', origin: 'https://app.example' }).ok).toBe(false);
    const consumed = tickets.consume({ rawTicket: issued.rawTicket, sessionId: session.id, deviceToken: device.raw, origin: 'https://app.example' });
    expect(consumed.ok).toBe(true);
    // The consume path must NOT scrub: the caller needs the key to open SSH.
    if (consumed.ok) expect(consumed.grant.profile.privateKey).toBe(profile.privateKey);
    expect(tickets.consume({ rawTicket: issued.rawTicket, sessionId: session.id, deviceToken: device.raw, origin: 'https://app.example' }).ok).toBe(false);
  });

  test('sweepExpired drops an unconsumed ticket and overwrites its key material', () => {
    const clock = createClock();
    const tickets = new InMemoryTerminalTicketStore(clock, 60_000);
    const issued = tickets.issue({
      sessionId: 'session-1',
      rawDeviceToken: 'device-raw',
      origin: 'https://app.example',
      profile: { ...profile, passphrase: 'top-secret' },
    });

    // Past the TTL with no further issue/consume: the lazy read-path cleanup
    // never runs, so only the active sweep can reclaim the key.
    clock.advance(60_001);
    tickets.sweepExpired();

    expect(issued.grant.profile.privateKey).toBe('');
    expect(issued.grant.profile.passphrase).toBe('');
    const result = tickets.consume({ rawTicket: issued.rawTicket, sessionId: 'session-1', deviceToken: 'device-raw', origin: 'https://app.example' });
    expect(result.ok).toBe(false);
  });

  test('sweepExpired removes expired sessions and overwrites the device raw token', () => {
    const clock = createClock();
    const sessions = new InMemoryAccessSessionStore(clock, 10);
    const devices = new InMemoryDeviceTokenStore(clock, 10);
    const { session, rawSessionToken } = sessions.create();
    const device = devices.create(session.id);

    clock.advance(11);
    sessions.sweepExpired();
    devices.sweepExpired();

    expect(device.raw).toBe('');
    expect(sessions.validate(session.id, rawSessionToken)).toBeNull();
    expect(devices.validate(session.id, 'device-raw')).toBeNull();
  });

  test('sweepExpired keeps still-valid tickets and their key intact', () => {
    const clock = createClock();
    const tickets = new InMemoryTerminalTicketStore(clock, 60_000);
    const issued = tickets.issue({ sessionId: 'session-1', rawDeviceToken: 'device-raw', origin: 'https://app.example', profile });

    clock.advance(30_000);
    tickets.sweepExpired();

    expect(issued.grant.profile.privateKey).toBe(profile.privateKey);
    const result = tickets.consume({ rawTicket: issued.rawTicket, sessionId: 'session-1', deviceToken: 'device-raw', origin: 'https://app.example' });
    expect(result.ok).toBe(true);
  });
});

describe('access rate limiter', () => {
  test('allows attempts while failures stay under the limit', () => {
    const limiter = new InMemoryAccessRateLimiter(createClock(), 3, 1_000);
    limiter.recordFailure('1.2.3.4');
    limiter.recordFailure('1.2.3.4');
    expect(limiter.check('1.2.3.4').allowed).toBe(true);
  });

  test('blocks once failures reach the limit and reports retry-after', () => {
    const limiter = new InMemoryAccessRateLimiter(createClock(), 3, 1_000);
    limiter.recordFailure('1.2.3.4');
    limiter.recordFailure('1.2.3.4');
    limiter.recordFailure('1.2.3.4');
    const decision = limiter.check('1.2.3.4');
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.retryAfterMs).toBeGreaterThan(0);
  });

  test('reset clears the counter so a successful login is not penalized', () => {
    const limiter = new InMemoryAccessRateLimiter(createClock(), 1, 1_000);
    limiter.recordFailure('1.2.3.4');
    expect(limiter.check('1.2.3.4').allowed).toBe(false);
    limiter.reset('1.2.3.4');
    expect(limiter.check('1.2.3.4').allowed).toBe(true);
  });

  test('allows again after the window elapses', () => {
    const clock = createClock();
    const limiter = new InMemoryAccessRateLimiter(clock, 1, 1_000);
    limiter.recordFailure('1.2.3.4');
    expect(limiter.check('1.2.3.4').allowed).toBe(false);
    clock.advance(1_000);
    expect(limiter.check('1.2.3.4').allowed).toBe(true);
  });

  test('tracks clients independently', () => {
    const limiter = new InMemoryAccessRateLimiter(createClock(), 1, 1_000);
    limiter.recordFailure('1.2.3.4');
    expect(limiter.check('1.2.3.4').allowed).toBe(false);
    expect(limiter.check('5.6.7.8').allowed).toBe(true);
  });
});
