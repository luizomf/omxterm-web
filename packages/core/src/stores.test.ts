import { describe, expect, test } from 'vitest';
import { InMemoryAccessSessionStore, InMemoryDeviceTokenStore, InMemoryTerminalTicketStore, type Clock } from './stores';

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
    expect(tickets.consume({ rawTicket: issued.rawTicket, sessionId: session.id, deviceToken: device.raw, origin: 'https://app.example' }).ok).toBe(true);
    expect(tickets.consume({ rawTicket: issued.rawTicket, sessionId: session.id, deviceToken: device.raw, origin: 'https://app.example' }).ok).toBe(false);
  });
});
