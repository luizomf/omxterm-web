import { describe, expect, test } from 'vitest';
import { hashSecret, InMemoryAccessCredentialStore, InMemoryAccessRateLimiter, InMemoryConcurrencyLimiter, InMemoryFixedWindowRateLimiter, InMemoryTerminalTicketStore, type Clock } from './stores';

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
  test('keeps session and device ownership paired while evicting the oldest client credentials', () => {
    const credentials = new InMemoryAccessCredentialStore(createClock(), 1_000, 2);
    const first = credentials.create('client-a');
    const second = credentials.create('client-a');
    const third = credentials.create('client-a');

    expect(first.evictedSessionId).toBeUndefined();
    expect(second.evictedSessionId).toBeUndefined();
    expect(third.evictedSessionId).toBe(first.session.id);
    expect(credentials.validate(first.session.id, first.rawSessionToken, first.rawDeviceToken)).toBeNull();
    expect(credentials.validate(second.session.id, second.rawSessionToken, second.rawDeviceToken)?.id).toBe(second.session.id);
    expect(credentials.validate(third.session.id, third.rawSessionToken, third.rawDeviceToken)?.id).toBe(third.session.id);
    expect(credentials.validate(third.session.id, third.rawSessionToken, second.rawDeviceToken)).toBeNull();
    expect(credentials.getLiveCredentialCounts()).toEqual({ clients: 1, sessions: 2, devices: 2, ownerships: 2 });
  });

  test('applies the live-credential capacity independently per client', () => {
    const credentials = new InMemoryAccessCredentialStore(createClock(), 1_000, 2);
    const firstClientOldest = credentials.create('client-a');
    credentials.create('client-a');
    const secondClient = credentials.create('client-b');
    credentials.create('client-a');

    expect(credentials.validate(firstClientOldest.session.id, firstClientOldest.rawSessionToken, firstClientOldest.rawDeviceToken)).toBeNull();
    expect(credentials.validate(secondClient.session.id, secondClient.rawSessionToken, secondClient.rawDeviceToken)?.id).toBe(secondClient.session.id);
    expect(credentials.getLiveCredentialCounts()).toEqual({ clients: 2, sessions: 3, devices: 3, ownerships: 3 });
  });

  test('sweeps expired credential pairs and their client ownership together', () => {
    const clock = createClock();
    const credentials = new InMemoryAccessCredentialStore(clock, 10, 2);
    const expired = credentials.create('client-a');

    clock.advance(11);
    expect(credentials.sweepExpired()).toBe(1);

    expect(credentials.validate(expired.session.id, expired.rawSessionToken, expired.rawDeviceToken)).toBeNull();
    expect(credentials.getLiveCredentialCounts()).toEqual({ clients: 0, sessions: 0, devices: 0, ownerships: 0 });
  });

  test('rejects a credential capacity that could never keep a successful login usable', () => {
    expect(() => new InMemoryAccessCredentialStore(createClock(), 1_000, 0)).toThrow(
      'Access credential capacity must be a positive integer. Received 0.',
    );
  });

  test('consumes terminal tickets only once and binds device/session/origin', () => {
    const credentials = new InMemoryAccessCredentialStore();
    const tickets = new InMemoryTerminalTicketStore();
    const { session, rawDeviceToken } = credentials.create('client-a');
    const issued = tickets.issue({ sessionId: session.id, rawDeviceToken, origin: 'https://app.example', profile });

    expect(tickets.consume({ rawTicket: issued.rawTicket, sessionId: session.id, deviceToken: 'bad', origin: 'https://app.example' }).ok).toBe(false);
    const consumed = tickets.consume({ rawTicket: issued.rawTicket, sessionId: session.id, deviceToken: rawDeviceToken, origin: 'https://app.example' });
    expect(consumed.ok).toBe(true);
    // The consume path must NOT scrub: the caller needs the key to open SSH.
    if (consumed.ok) expect(consumed.grant.profile.privateKey).toBe(profile.privateKey);
    expect(tickets.consume({ rawTicket: issued.rawTicket, sessionId: session.id, deviceToken: rawDeviceToken, origin: 'https://app.example' }).ok).toBe(false);
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

  test('create returns a minimal immutable snapshot that cannot forge stored credentials', () => {
    const credentials = new InMemoryAccessCredentialStore();
    const issued = credentials.create('client-a');
    const exposedRecords = issued as unknown as {
      session: Record<string, unknown>;
      device?: Record<string, unknown>;
    };
    const forgedSessionToken = 'forged-session-token';
    const forgedDeviceToken = 'forged-device-token';

    Reflect.set(exposedRecords.session, 'tokenHash', hashSecret(forgedSessionToken));
    if (exposedRecords.device) {
      Reflect.set(exposedRecords.device, 'hash', hashSecret(forgedDeviceToken));
    }

    expect(
      credentials.validate(issued.session.id, forgedSessionToken, forgedDeviceToken),
    ).toBeNull();
    expect(Object.keys(issued).sort()).toEqual([
      'rawDeviceToken',
      'rawSessionToken',
      'session',
    ]);
    expect(Object.keys(issued.session).sort()).toEqual([
      'createdAt',
      'expiresAt',
      'id',
    ]);
    expect(Object.isFrozen(issued)).toBe(true);
    expect(Object.isFrozen(issued.session)).toBe(true);
  });

  test('validate returns an immutable snapshot instead of stored ownership state', () => {
    const credentials = new InMemoryAccessCredentialStore();
    const issued = credentials.create('client-a');
    const validated = credentials.validate(
      issued.session.id,
      issued.rawSessionToken,
      issued.rawDeviceToken,
    );

    expect(validated).not.toBeNull();
    if (!validated) return;
    Reflect.set(validated, 'id', 'attacker-controlled-session');

    expect(Object.isFrozen(validated)).toBe(true);
    expect(
      credentials.validate(
        issued.session.id,
        issued.rawSessionToken,
        issued.rawDeviceToken,
      )?.id,
    ).toBe(issued.session.id);
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

  test('sweepExpired reclaims failure windows that have fully elapsed', () => {
    const clock = createClock();
    const limiter = new InMemoryAccessRateLimiter(clock, 1, 1_000);
    // Distinct client keys (rotating IPs) each open a window and are never hit
    // again — the #78 leak: check()/recordFailure() only prune on a repeat of
    // the same key, so only the active sweep can reclaim these.
    limiter.recordFailure('1.1.1.1');
    limiter.recordFailure('2.2.2.2');
    limiter.recordFailure('3.3.3.3');

    clock.advance(1_000);
    expect(limiter.sweepExpired()).toBe(3);
    // A second sweep finds nothing: the entries were dropped, not just counted.
    expect(limiter.sweepExpired()).toBe(0);
  });

  test('sweepExpired leaves an active window and its retry-after untouched', () => {
    const clock = createClock();
    const limiter = new InMemoryAccessRateLimiter(clock, 1, 1_000);
    limiter.recordFailure('1.2.3.4');
    clock.advance(400);
    const before = limiter.check('1.2.3.4');

    expect(limiter.sweepExpired()).toBe(0);

    const after = limiter.check('1.2.3.4');
    expect(before.allowed).toBe(false);
    expect(after.allowed).toBe(false);
    // Same clock reading before and after the sweep → identical retry-after.
    if (!before.allowed && !after.allowed) {
      expect(after.retryAfterMs).toBe(before.retryAfterMs);
      expect(after.retryAfterMs).toBe(600);
    }
  });

  test('sweepExpired keeps a still-open window counting toward the lockout', () => {
    const clock = createClock();
    const limiter = new InMemoryAccessRateLimiter(clock, 2, 1_000);
    limiter.recordFailure('1.2.3.4'); // 1 of 2, still under the limit

    clock.advance(400);
    expect(limiter.sweepExpired()).toBe(0);

    // The window survived the sweep, so the next failure trips the limit — a
    // wiped window would reset the count and weaken the brute-force lockout.
    limiter.recordFailure('1.2.3.4');
    expect(limiter.check('1.2.3.4').allowed).toBe(false);
  });
});

describe('fixed-window rate limiter', () => {
  test('allows attempts up to the cap then blocks with retry-after', () => {
    const limiter = new InMemoryFixedWindowRateLimiter(createClock(), 2, 1_000);
    expect(limiter.tryConsume('session-1').allowed).toBe(true);
    expect(limiter.tryConsume('session-1').allowed).toBe(true);
    const decision = limiter.tryConsume('session-1');
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.retryAfterMs).toBeGreaterThan(0);
  });

  test('counts every attempt, not just failures', () => {
    const limiter = new InMemoryFixedWindowRateLimiter(createClock(), 1, 1_000);
    expect(limiter.tryConsume('session-1').allowed).toBe(true);
    expect(limiter.tryConsume('session-1').allowed).toBe(false);
  });

  test('consumes combined budgets atomically without charging available keys on rejection', () => {
    const limiter = new InMemoryFixedWindowRateLimiter(createClock(), 2, 1_000);
    limiter.tryConsume('session:exhausted');
    limiter.tryConsume('session:exhausted');

    expect(
      limiter.tryConsumeAll(['session:exhausted', 'client:available']).allowed,
    ).toBe(false);
    expect(limiter.tryConsume('client:available').allowed).toBe(true);
    expect(limiter.tryConsume('client:available').allowed).toBe(true);
    expect(limiter.tryConsume('client:available').allowed).toBe(false);
  });

  test('opens a fresh window once the previous one elapses', () => {
    const clock = createClock();
    const limiter = new InMemoryFixedWindowRateLimiter(clock, 1, 1_000);
    expect(limiter.tryConsume('session-1').allowed).toBe(true);
    expect(limiter.tryConsume('session-1').allowed).toBe(false);
    clock.advance(1_000);
    expect(limiter.tryConsume('session-1').allowed).toBe(true);
  });

  test('reports a shrinking retry-after as the window drains', () => {
    const clock = createClock();
    const limiter = new InMemoryFixedWindowRateLimiter(clock, 1, 1_000);
    limiter.tryConsume('session-1');
    clock.advance(400);
    const decision = limiter.tryConsume('session-1');
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.retryAfterMs).toBe(600);
  });

  test('tracks keys independently', () => {
    const limiter = new InMemoryFixedWindowRateLimiter(createClock(), 1, 1_000);
    expect(limiter.tryConsume('session-1').allowed).toBe(true);
    expect(limiter.tryConsume('session-1').allowed).toBe(false);
    expect(limiter.tryConsume('session-2').allowed).toBe(true);
  });

  test('sweepExpired reclaims windows whose fixed window has fully elapsed', () => {
    const clock = createClock();
    const limiter = new InMemoryFixedWindowRateLimiter(clock, 1, 1_000);
    limiter.tryConsume('session-1');
    limiter.tryConsume('session-2');

    // Past the window with no further consume on either key: the lazy reopen on
    // tryConsume never runs, so only the active sweep can reclaim these windows
    // (the #39 leak — keys are per-login UUIDs, so they never repeat).
    clock.advance(1_000);
    expect(limiter.sweepExpired()).toBe(2);
  });

  test('sweepExpired keeps a window that is still open', () => {
    const clock = createClock();
    const limiter = new InMemoryFixedWindowRateLimiter(clock, 1, 1_000);
    limiter.tryConsume('session-1');

    clock.advance(400);
    expect(limiter.sweepExpired()).toBe(0);
    // The preserved window still counts, so a repeat inside it stays blocked.
    expect(limiter.tryConsume('session-1').allowed).toBe(false);
  });
});

describe('concurrency limiter', () => {
  test('admits holders up to the cap then refuses', () => {
    const limiter = new InMemoryConcurrencyLimiter(2);
    expect(limiter.tryAcquire('session-1')).toBe(true);
    expect(limiter.tryAcquire('session-1')).toBe(true);
    expect(limiter.tryAcquire('session-1')).toBe(false);
  });

  test('releasing a slot lets a new holder in', () => {
    const limiter = new InMemoryConcurrencyLimiter(1);
    expect(limiter.tryAcquire('session-1')).toBe(true);
    expect(limiter.tryAcquire('session-1')).toBe(false);
    limiter.release('session-1');
    expect(limiter.tryAcquire('session-1')).toBe(true);
  });

  test('tracks keys independently', () => {
    const limiter = new InMemoryConcurrencyLimiter(1);
    expect(limiter.tryAcquire('session-1')).toBe(true);
    expect(limiter.tryAcquire('session-2')).toBe(true);
    expect(limiter.tryAcquire('session-1')).toBe(false);
  });

  test('releasing an idle key never frees capacity below zero', () => {
    const limiter = new InMemoryConcurrencyLimiter(1);
    limiter.release('session-1');
    limiter.release('session-1');
    expect(limiter.tryAcquire('session-1')).toBe(true);
    expect(limiter.tryAcquire('session-1')).toBe(false);
  });
});
