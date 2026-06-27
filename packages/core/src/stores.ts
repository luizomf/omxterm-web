import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export type Clock = { now(): number };
export const systemClock: Clock = { now: () => Date.now() };

export type AccessSession = {
  id: string;
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
};

export type DeviceToken = {
  raw: string;
  hash: string;
  createdAt: number;
  expiresAt: number;
};

export type SshConnectionProfile = {
  host: string;
  port: number;
  username: string;
  privateKey: string;
  passphrase?: string;
  acceptedHostFingerprint: string;
};

export type TerminalTicketGrant = {
  id: string;
  ticketHash: string;
  sessionId: string;
  deviceHash: string;
  origin: string;
  profile: SshConnectionProfile;
  issuedAt: number;
  expiresAt: number;
  usedAt?: number;
};

export type ConsumeTicketInput = {
  rawTicket: string;
  sessionId: string;
  deviceToken: string;
  origin: string;
};

export type ConsumeTicketResult =
  | { ok: true; grant: TerminalTicketGrant }
  | { ok: false; reason: 'not_found_expired_or_used' | 'session_device_or_origin_mismatch' };

export function createOpaqueSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function safeEqualHash(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export class InMemoryAccessSessionStore {
  readonly #sessions = new Map<string, AccessSession>();

  constructor(
    private readonly clock: Clock = systemClock,
    private readonly sessionTtlMs = 12 * 60 * 60 * 1000,
  ) {}

  create(): { rawSessionToken: string; session: AccessSession } {
    const rawSessionToken = createOpaqueSecret();
    const now = this.clock.now();
    const session: AccessSession = {
      id: randomUUID(),
      tokenHash: hashSecret(rawSessionToken),
      createdAt: now,
      expiresAt: now + this.sessionTtlMs,
    };
    this.#sessions.set(session.id, session);
    return { rawSessionToken, session };
  }

  validate(sessionId: string | undefined, rawSessionToken: string | undefined): AccessSession | null {
    if (!sessionId || !rawSessionToken) return null;
    const session = this.#sessions.get(sessionId);
    if (!session || session.expiresAt <= this.clock.now()) return null;
    if (!safeEqualHash(session.tokenHash, hashSecret(rawSessionToken))) return null;
    return session;
  }
}

export class InMemoryDeviceTokenStore {
  readonly #devices = new Map<string, DeviceToken>();

  constructor(
    private readonly clock: Clock = systemClock,
    private readonly deviceTtlMs = 12 * 60 * 60 * 1000,
  ) {}

  create(sessionId: string): DeviceToken {
    const raw = createOpaqueSecret();
    const now = this.clock.now();
    const device: DeviceToken = { raw, hash: hashSecret(raw), createdAt: now, expiresAt: now + this.deviceTtlMs };
    this.#devices.set(sessionId, device);
    return device;
  }

  validate(sessionId: string | undefined, rawDeviceToken: string | undefined): DeviceToken | null {
    if (!sessionId || !rawDeviceToken) return null;
    const device = this.#devices.get(sessionId);
    if (!device || device.expiresAt <= this.clock.now()) return null;
    if (!safeEqualHash(device.hash, hashSecret(rawDeviceToken))) return null;
    return device;
  }
}

export class InMemoryTerminalTicketStore {
  readonly #tickets = new Map<string, TerminalTicketGrant>();

  constructor(
    private readonly clock: Clock = systemClock,
    private readonly ticketTtlMs = 60 * 1000,
  ) {}

  issue(input: { sessionId: string; rawDeviceToken: string; origin: string; profile: SshConnectionProfile }): { rawTicket: string; grant: TerminalTicketGrant } {
    this.#deleteExpired();
    const rawTicket = createOpaqueSecret();
    const now = this.clock.now();
    const grant: TerminalTicketGrant = {
      id: randomUUID(),
      ticketHash: hashSecret(rawTicket),
      sessionId: input.sessionId,
      deviceHash: hashSecret(input.rawDeviceToken),
      origin: input.origin,
      profile: input.profile,
      issuedAt: now,
      expiresAt: now + this.ticketTtlMs,
    };
    this.#tickets.set(grant.ticketHash, grant);
    return { rawTicket, grant };
  }

  consume(input: ConsumeTicketInput): ConsumeTicketResult {
    this.#deleteExpired();
    const ticketHash = hashSecret(input.rawTicket);
    const grant = this.#tickets.get(ticketHash);
    if (!grant || grant.usedAt || grant.expiresAt <= this.clock.now()) {
      return { ok: false, reason: 'not_found_expired_or_used' };
    }

    const matchesContext =
      grant.sessionId === input.sessionId &&
      grant.origin === input.origin &&
      safeEqualHash(grant.deviceHash, hashSecret(input.deviceToken));

    if (!matchesContext) {
      return { ok: false, reason: 'session_device_or_origin_mismatch' };
    }

    grant.usedAt = this.clock.now();
    this.#tickets.delete(ticketHash);
    return { ok: true, grant };
  }

  #deleteExpired(): void {
    const now = this.clock.now();
    for (const [ticketHash, grant] of this.#tickets.entries()) {
      if (grant.expiresAt <= now || grant.usedAt) {
        this.#tickets.delete(ticketHash);
      }
    }
  }
}
