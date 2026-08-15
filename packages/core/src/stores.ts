import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export type Clock = { now(): number };
export const systemClock: Clock = { now: () => Date.now() };

export type AccessSession = Readonly<{
  id: string;
  createdAt: number;
  expiresAt: number;
}>;

type StoredAccessSession = AccessSession & {
  tokenHash: string;
};

type StoredDeviceToken = {
  hash: string;
  createdAt: number;
  expiresAt: number;
};

// Mutable, one-attempt connection input. Ownership transfers to SSH
// establishment when connect starts; callers must not reuse the profile after
// that point. Credential fields are cleared as references are released.
export type SshConnectionProfile = {
  host: string;
  port: number;
  username: string;
  privateKey: string;
  passphrase?: string;
  acceptedHostFingerprint: string;
  // IP the egress allowlist validated at request time. The dial targets this
  // pinned address instead of re-resolving `host`, closing the DNS-rebinding
  // window between the egress check and the SSH dial (#26). Absent in
  // unrestricted mode, where nothing is resolved and the dial uses `host`.
  pinnedAddress?: string;
};

// Drops OMXTerm-owned references; it does not overwrite immutable string
// storage or make a JavaScript/V8 memory-zeroization claim.
export function releaseSshConnectionCredentials(
  profile: SshConnectionProfile,
): void {
  profile.privateKey = '';
  if (profile.passphrase !== undefined) profile.passphrase = '';
}

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

export type IssuedAccessCredentials = Readonly<{
  rawSessionToken: string;
  rawDeviceToken: string;
  session: AccessSession;
  evictedSessionId?: string;
}>;

export type LiveAccessCredentialState = {
  clients: number;
  sessions: number;
  devices: number;
  ownerships: number;
};

/**
 * Owns access sessions and device tokens as one bounded credential pair.
 *
 * A successful login may always mint a fresh pair. Once one client's capacity
 * is full, the oldest pair is revoked before the new pair is published. Keeping
 * both hashes and the client ownership index behind this interface prevents an
 * eviction or expiry sweep from leaving one half authorized by mistake.
 */
export class InMemoryAccessCredentialStore {
  readonly #sessions = new Map<string, StoredAccessSession>();
  readonly #devices = new Map<string, StoredDeviceToken>();
  readonly #clientBySessionId = new Map<string, string>();
  readonly #sessionIdsByClient = new Map<string, Set<string>>();

  constructor(
    private readonly clock: Clock = systemClock,
    private readonly credentialTtlMs = 12 * 60 * 60 * 1000,
    private readonly maxSessionsPerClient = 5,
  ) {
    if (!Number.isInteger(maxSessionsPerClient) || maxSessionsPerClient <= 0) {
      throw new Error(
        `Access credential capacity must be a positive integer. Received ${maxSessionsPerClient}.`,
      );
    }
  }

  create(clientKey: string): IssuedAccessCredentials {
    const now = this.clock.now();
    this.#sweepExpiredForClient(clientKey, now);

    const rawSessionToken = createOpaqueSecret();
    const rawDeviceToken = createOpaqueSecret();
    const session: StoredAccessSession = {
      id: randomUUID(),
      tokenHash: hashSecret(rawSessionToken),
      createdAt: now,
      expiresAt: now + this.credentialTtlMs,
    };
    const device: StoredDeviceToken = {
      hash: hashSecret(rawDeviceToken),
      createdAt: now,
      expiresAt: now + this.credentialTtlMs,
    };

    const oldestSessionId = this.#oldestSessionIdAtCapacity(clientKey);
    if (oldestSessionId) this.#revoke(oldestSessionId);

    const clientSessions = this.#sessionIdsByClient.get(clientKey) ?? new Set<string>();
    clientSessions.add(session.id);
    this.#sessionIdsByClient.set(clientKey, clientSessions);
    this.#sessions.set(session.id, session);
    this.#devices.set(session.id, device);
    this.#clientBySessionId.set(session.id, clientKey);

    return Object.freeze({
      rawSessionToken,
      rawDeviceToken,
      session: accessSessionSnapshot(session),
      ...(oldestSessionId ? { evictedSessionId: oldestSessionId } : {}),
    });
  }

  validate(
    sessionId: string | undefined,
    rawSessionToken: string | undefined,
    rawDeviceToken: string | undefined,
  ): AccessSession | null {
    if (!sessionId || !rawSessionToken || !rawDeviceToken) return null;
    const session = this.#sessions.get(sessionId);
    const device = this.#devices.get(sessionId);
    const now = this.clock.now();
    if (!session || !device || session.expiresAt <= now || device.expiresAt <= now) {
      return null;
    }
    if (!safeEqualHash(session.tokenHash, hashSecret(rawSessionToken))) return null;
    if (!safeEqualHash(device.hash, hashSecret(rawDeviceToken))) return null;
    return accessSessionSnapshot(session);
  }

  sweepExpired(): number {
    const now = this.clock.now();
    let revoked = 0;
    for (const [sessionId, session] of this.#sessions) {
      const device = this.#devices.get(sessionId);
      if (session.expiresAt > now && device && device.expiresAt > now) continue;
      this.#revoke(sessionId);
      revoked += 1;
    }
    return revoked;
  }

  getLiveCredentialCounts(): LiveAccessCredentialState {
    return {
      clients: this.#sessionIdsByClient.size,
      sessions: this.#sessions.size,
      devices: this.#devices.size,
      ownerships: this.#clientBySessionId.size,
    };
  }

  #oldestSessionIdAtCapacity(clientKey: string): string | undefined {
    const clientSessions = this.#sessionIdsByClient.get(clientKey);
    if (!clientSessions || clientSessions.size < this.maxSessionsPerClient) return undefined;
    return clientSessions.values().next().value;
  }

  #sweepExpiredForClient(clientKey: string, now: number): void {
    const clientSessions = this.#sessionIdsByClient.get(clientKey);
    if (!clientSessions) return;
    for (const sessionId of [...clientSessions]) {
      const session = this.#sessions.get(sessionId);
      const device = this.#devices.get(sessionId);
      if (session && device && session.expiresAt > now && device.expiresAt > now) continue;
      this.#revoke(sessionId);
    }
  }

  #revoke(sessionId: string): void {
    const clientKey = this.#clientBySessionId.get(sessionId);
    this.#sessions.delete(sessionId);
    this.#devices.delete(sessionId);
    this.#clientBySessionId.delete(sessionId);
    if (!clientKey) return;
    const clientSessions = this.#sessionIdsByClient.get(clientKey);
    clientSessions?.delete(sessionId);
    if (clientSessions?.size === 0) this.#sessionIdsByClient.delete(clientKey);
  }
}

function accessSessionSnapshot(session: StoredAccessSession): AccessSession {
  return Object.freeze({
    id: session.id,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
  });
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

  // Active expiry (#29): drop expired/used grants and release their SSH
  // credential references, so an unconsumed ticket cannot retain them past its
  // TTL. Successful consume transfers the one-attempt profile to SSH
  // establishment instead.
  sweepExpired(): void {
    const now = this.clock.now();
    for (const [ticketHash, grant] of this.#tickets.entries()) {
      if (grant.expiresAt <= now || grant.usedAt) {
        releaseSshConnectionCredentials(grant.profile);
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
 *
 * check()/recordFailure() only prune an elapsed window when the *same* client
 * key is touched again, but the key is the client IP — rotating source/IPv6
 * addresses never repeat, so elapsed windows would otherwise pile up unbounded
 * across a long-lived public broker (#78, the same stale-window class as #39).
 * sweepExpired() lets the active sweeper (#29) reclaim them on a cadence; it
 * implements ExpiringStore so it joins startExpirySweeper.
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

  // Drops windows whose fixed window has fully elapsed — the same condition
  // check() prunes lazily on a repeat hit — so active windows (still counting or
  // blocked with retry-after) are left untouched. Returns how many were
  // reclaimed, the only externally observable effect of the sweep.
  sweepExpired(): number {
    const now = this.clock.now();
    let dropped = 0;
    for (const [clientKey, record] of this.#failuresByClient) {
      if (now - record.windowStartedAt >= this.windowMs) {
        this.#failuresByClient.delete(clientKey);
        dropped += 1;
      }
    }
    return dropped;
  }
}

type RateWindow = { count: number; windowStartedAt: number };

/**
 * Fixed-window limiter that counts *every* attempt against a cap, keyed by client.
 *
 * The access limiter above only records failed logins (and resets on success);
 * this one caps the rate of authenticated operations — outbound host-key probes
 * and ticket issuance (#30) — so a single session can't flood the broker or a
 * target host. tryConsume() checks and increments in one step, so the caller
 * can't forget to record an allowed attempt.
 *
 * tryConsume() only reopens a stale window when the *same* key is touched again,
 * but this limiter is keyed by session id — a fresh UUID per login — so a key
 * never repeats and elapsed windows would otherwise pile up unbounded across a
 * long-lived process (#39). sweepExpired() lets the active sweeper (#29) reclaim
 * them on a cadence; it implements ExpiringStore so it joins startExpirySweeper.
 */
export class InMemoryFixedWindowRateLimiter {
  readonly #windowsByKey = new Map<string, RateWindow>();

  constructor(
    private readonly clock: Clock = systemClock,
    private readonly maxPerWindow = 30,
    private readonly windowMs = 60 * 1000,
  ) {}

  tryConsume(clientKey: string): RateLimitDecision {
    return this.tryConsumeAll([clientKey]);
  }

  /**
   * Consumes every supplied budget or none of them.
   *
   * Decisions are evaluated before any window is created or incremented. This
   * keeps a denied combined policy from leaking fresh per-session keys or
   * charging an otherwise available budget for work that was not admitted.
   */
  tryConsumeAll(clientKeys: readonly string[]): RateLimitDecision {
    const now = this.clock.now();
    for (const clientKey of clientKeys) {
      const decision = this.#check(clientKey, now);
      if (!decision.allowed) return decision;
    }
    for (const clientKey of clientKeys) this.#consume(clientKey, now);
    return { allowed: true };
  }

  #check(clientKey: string, now: number): RateLimitDecision {
    const record = this.#windowsByKey.get(clientKey);
    if (!record || now - record.windowStartedAt >= this.windowMs)
      return { allowed: true };
    if (record.count >= this.maxPerWindow) {
      return { allowed: false, retryAfterMs: this.windowMs - (now - record.windowStartedAt) };
    }
    return { allowed: true };
  }

  #consume(clientKey: string, now: number): void {
    const record = this.#windowsByKey.get(clientKey);
    if (!record || now - record.windowStartedAt >= this.windowMs) {
      this.#windowsByKey.set(clientKey, { count: 1, windowStartedAt: now });
      return;
    }
    record.count += 1;
  }

  // Drops windows that have fully elapsed (a later request just reopens a fresh
  // one). Returns how many were reclaimed — the only externally observable effect
  // of the sweep, since tryConsume() reopens elapsed windows lazily regardless.
  sweepExpired(): number {
    const now = this.clock.now();
    let dropped = 0;
    for (const [clientKey, record] of this.#windowsByKey) {
      if (now - record.windowStartedAt >= this.windowMs) {
        this.#windowsByKey.delete(clientKey);
        dropped += 1;
      }
    }
    return dropped;
  }
}

/**
 * Caps the number of concurrent holders per key.
 *
 * Used for active SSH terminal sessions per access session and for total live
 * WebSocket connections (a single constant key) (#30), so one session — or all
 * sessions together — can't exhaust the broker's sockets/FDs. Acquire when a
 * connection is admitted, release when it closes. release() never drives a count
 * below zero, but the caller must release at most once per successful acquire
 * (double-release would free another holder's slot), so wire it behind a
 * once-only guard on the connection.
 */
export class InMemoryConcurrencyLimiter {
  readonly #activeByKey = new Map<string, number>();

  constructor(private readonly maxConcurrent = 5) {}

  tryAcquire(key: string): boolean {
    const active = this.#activeByKey.get(key) ?? 0;
    if (active >= this.maxConcurrent) return false;
    this.#activeByKey.set(key, active + 1);
    return true;
  }

  release(key: string): void {
    const active = this.#activeByKey.get(key) ?? 0;
    if (active <= 1) {
      this.#activeByKey.delete(key);
      return;
    }
    this.#activeByKey.set(key, active - 1);
  }
}
