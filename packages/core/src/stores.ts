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

  // Active expiry (#29): sessions only hold a token hash (no raw secret), but a
  // long-lived process would otherwise accumulate expired entries forever, since
  // validate() never deletes.
  sweepExpired(): void {
    const now = this.clock.now();
    for (const [sessionId, session] of this.#sessions.entries()) {
      if (session.expiresAt <= now) this.#sessions.delete(sessionId);
    }
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

  // Active expiry (#29): the stored token keeps its raw value (only handed out at
  // create() time, never re-read here — validate() compares hashes), so overwrite
  // it before dropping the expired entry instead of leaving the secret to linger.
  sweepExpired(): void {
    const now = this.clock.now();
    for (const [sessionId, device] of this.#devices.entries()) {
      if (device.expiresAt <= now) {
        device.raw = '';
        this.#devices.delete(sessionId);
      }
    }
  }
}

export class InMemoryTerminalTicketStore {
  readonly #tickets = new Map<string, TerminalTicketGrant>();

  constructor(
    private readonly clock: Clock = systemClock,
    private readonly ticketTtlMs = 60 * 1000,
  ) {}

  issue(input: { sessionId: string; rawDeviceToken: string; origin: string; profile: SshConnectionProfile }): { rawTicket: string; grant: TerminalTicketGrant } {
    this.sweepExpired();
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
    this.sweepExpired();
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

  // Active expiry (#29): drop expired/used grants and overwrite the SSH key
  // material before releasing the reference, so an unconsumed ticket can't keep
  // a private key in memory past its TTL. The successful-consume path deletes
  // without scrubbing on purpose — there the grant (and its key) is handed to
  // the caller to open the SSH session.
  sweepExpired(): void {
    const now = this.clock.now();
    for (const [ticketHash, grant] of this.#tickets.entries()) {
      if (grant.expiresAt <= now || grant.usedAt) {
        grant.profile.privateKey = '';
        if (grant.profile.passphrase) grant.profile.passphrase = '';
        this.#tickets.delete(ticketHash);
      }
    }
  }
}

export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

type FailureWindow = { count: number; windowStartedAt: number };

/**
 * Fixed-window limiter for failed access-gate attempts, keyed by client.
 *
 * The access token is the single gate in front of an SSH proxy, so without a
 * limiter it can be brute-forced unbounded (timingSafeEqual only blocks timing
 * side channels, not guessing). Successful logins reset the counter, so only
 * brute-force traffic — which never succeeds — accumulates toward the lockout.
 */
export class InMemoryAccessRateLimiter {
  readonly #failuresByClient = new Map<string, FailureWindow>();

  constructor(
    private readonly clock: Clock = systemClock,
    private readonly maxFailures = 10,
    private readonly windowMs = 60 * 1000,
  ) {}

  check(clientKey: string): RateLimitDecision {
    const record = this.#failuresByClient.get(clientKey);
    if (!record) return { allowed: true };

    const elapsed = this.clock.now() - record.windowStartedAt;
    if (elapsed >= this.windowMs) {
      this.#failuresByClient.delete(clientKey);
      return { allowed: true };
    }
    if (record.count >= this.maxFailures) {
      return { allowed: false, retryAfterMs: this.windowMs - elapsed };
    }
    return { allowed: true };
  }

  recordFailure(clientKey: string): void {
    const now = this.clock.now();
    const record = this.#failuresByClient.get(clientKey);
    if (!record || now - record.windowStartedAt >= this.windowMs) {
      this.#failuresByClient.set(clientKey, { count: 1, windowStartedAt: now });
      return;
    }
    record.count += 1;
  }

  reset(clientKey: string): void {
    this.#failuresByClient.delete(clientKey);
  }
}
