import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import fastifyStatic from "@fastify/static";
import type { AuditLogger } from "@omxterm/core/audit";
import { createJsonTerminalProtocolCodec } from "@omxterm/core/protocol";
import { MAX_PRIVATE_KEY_BYTES } from "@omxterm/core/ssh";
import {
  InMemoryAccessCredentialStore,
  InMemoryAccessRateLimiter,
  InMemoryConcurrencyLimiter,
  InMemoryFixedWindowRateLimiter,
  InMemoryTerminalTicketStore,
  systemClock,
  type AccessSession,
  type SshConnectionProfile,
} from "@omxterm/core/stores";
import { startExpirySweeper } from "@omxterm/core/sweeper";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { isOriginAllowed } from "./allowed-origins";
import type { ServerConfig } from "./config";
import {
  DEVICE_TOKEN_COOKIE,
  parseCookieHeader,
  readAuthCookies,
  SESSION_ID_COOKIE,
  SESSION_TOKEN_COOKIE,
  setAuthCookies,
} from "./cookies";
import { createAuditSink, JsonlAuditLogger } from "./audit-logger";
import {
  normalizeHostKeyProbeFailure,
  probeSshHostKey,
  SshConnectError,
  SshTerminalSession,
} from "./ssh";
import { checkSshEgress, resolveHostAddresses } from "./ssh-egress-policy";
import { createOutputBackpressure } from "./terminal-backpressure";
import { createTerminalInboundGuard } from "./terminal-inbound-guard";
import { startWebSocketHeartbeat } from "./websocket-heartbeat";

const MAX_ACCESS_TOKEN_CODE_UNITS = 4096;
const MAX_HOST_CODE_UNITS = 255;
const MAX_USERNAME_CODE_UNITS = 128;
const MAX_PASSPHRASE_CODE_UNITS = 4096;
const MAX_FINGERPRINT_CODE_UNITS = 256;

const accessSchema = z.object({
  accessToken: z.string().min(1).max(MAX_ACCESS_TOKEN_CODE_UNITS),
});
const hostKeySchema = z.object({
  host: z.string().min(1).max(MAX_HOST_CODE_UNITS),
  port: z.number().int().min(1).max(65535).default(22),
});
const terminalTicketSchema = z.object({
  host: z.string().min(1).max(MAX_HOST_CODE_UNITS),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1).max(MAX_USERNAME_CODE_UNITS),
  privateKey: z
    .string()
    .min(1)
    .max(MAX_PRIVATE_KEY_BYTES)
    .refine(
      (privateKey) =>
        Buffer.byteLength(privateKey, "utf8") <= MAX_PRIVATE_KEY_BYTES,
      { message: "Private key exceeds the UTF-8 byte limit." },
    ),
  passphrase: z.string().max(MAX_PASSPHRASE_CODE_UNITS).optional(),
  acceptedHostFingerprint: z
    .string()
    .min(1)
    .max(MAX_FINGERPRINT_CODE_UNITS),
});

type Stores = {
  accessCredentials: InMemoryAccessCredentialStore;
  tickets: InMemoryTerminalTicketStore;
  accessGrantAuditLimiter: InMemoryFixedWindowRateLimiter;
  unauthenticatedRejectionAuditLimiter: InMemoryFixedWindowRateLimiter;
  authenticatedWsRejectionAuditLimiter: InMemoryFixedWindowRateLimiter;
  accessRateLimiter: InMemoryAccessRateLimiter;
  hostKeyRateLimiter: InMemoryFixedWindowRateLimiter;
  ticketRateLimiter: InMemoryFixedWindowRateLimiter;
  wsUpgradeRateLimiter: InMemoryFixedWindowRateLimiter;
  sessionConcurrency: InMemoryConcurrencyLimiter;
  wsConcurrency: InMemoryConcurrencyLimiter;
};

// How often the active expiry sweeper runs (#29). The cadence is driven by the
// most sensitive store: terminal tickets carry the SSH private key on a 60s TTL,
// so sweeping every 10s caps how long an unconsumed key can linger past expiry.
// Sessions/devices (12h TTL) ride the same sweep cheaply.
const EXPIRY_SWEEP_INTERVAL_MS = 10 * 1000;

// Access-gate abuse policy (#97): how many failed access-token attempts one
// client may make before POST /api/access starts answering 429, and how long
// that lockout window lasts. Named and exported (instead of leaning on
// InMemoryAccessRateLimiter's constructor defaults) so the policy is
// discoverable in server code and HTTP-boundary tests assert against the real
// values instead of duplicating magic numbers.
export const ACCESS_GATE_MAX_FAILURES = 10;
export const ACCESS_GATE_WINDOW_MS = 60 * 1000;

// Public unauthenticated requests are still rejected on every attempt. Only
// repeated durable writes are capped per direct peer and normalized reason:
// bad Origin, blocked access gate, missing WebSocket credentials, and malformed
// upgrade targets can each otherwise grow JSONL without bound (#144). The direct
// peer plus this closed reason set keeps attacker-controlled request metadata out
// of limiter keys. Keeping the audit budget separate preserves every response.
export const MAX_UNAUTHENTICATED_REJECTION_AUDITS_PER_REASON_PER_WINDOW = 10;
export const UNAUTHENTICATED_REJECTION_AUDIT_WINDOW_MS = 60 * 1000;

// Authenticated upgrade failures used to bypass every post-auth rate limit and
// write one durable event per short-lived socket. Keep normal ticket use far
// below a generous attempt budget while bounding both work and rejection logs.
export const MAX_AUTHENTICATED_WS_UPGRADE_ATTEMPTS_PER_WINDOW = 60;
export const MAX_AUTHENTICATED_WS_REJECTION_AUDITS_PER_REASON_PER_WINDOW = 10;
export const AUTHENTICATED_WS_UPGRADE_WINDOW_MS = 60 * 1000;

// Parse only the input envelope each route actually supports. JSON can encode
// one UTF-16 code unit as a six-byte `\uXXXX` escape, so the parser envelope
// must cover that worst case before Zod applies decoded string/UTF-8 limits.
// A small fixed allowance covers property names, punctuation, and the port.
const MAX_JSON_BYTES_PER_STRING_CODE_UNIT = 6;
const JSON_OBJECT_OVERHEAD_BYTES = 1024;
export const ACCESS_REQUEST_BODY_LIMIT_BYTES =
  MAX_ACCESS_TOKEN_CODE_UNITS * MAX_JSON_BYTES_PER_STRING_CODE_UNIT +
  JSON_OBJECT_OVERHEAD_BYTES;
export const HOST_KEY_REQUEST_BODY_LIMIT_BYTES =
  MAX_HOST_CODE_UNITS * MAX_JSON_BYTES_PER_STRING_CODE_UNIT +
  JSON_OBJECT_OVERHEAD_BYTES;
export const TERMINAL_TICKET_REQUEST_BODY_LIMIT_BYTES =
  (MAX_PRIVATE_KEY_BYTES +
    MAX_HOST_CODE_UNITS +
    MAX_USERNAME_CODE_UNITS +
    MAX_PASSPHRASE_CODE_UNITS +
    MAX_FINGERPRINT_CODE_UNITS) *
    MAX_JSON_BYTES_PER_STRING_CODE_UNIT +
  JSON_OBJECT_OVERHEAD_BYTES;

// Successful access requests remain usable under rotation, but only this many
// access_granted records are persisted per direct TCP peer in one fixed window.
// Using the peer rather than request.ip prevents a trusted-proxy header from
// multiplying durable writes; the event remains metadata-only and the response
// is unchanged when its audit budget is exhausted (#145).
export const MAX_ACCESS_GRANT_AUDITS_PER_DIRECT_PEER_PER_WINDOW = 10;
export const ACCESS_GRANT_AUDIT_WINDOW_MS = 60 * 1000;

type BoundedUnauthenticatedRejectionReason =
  "bad_origin" | "rate_limited" | "missing_auth_or_ticket" | "upgrade_error";

type BoundedAuthenticatedWsRejectionReason =
  | "rate_limited"
  | "too_many_ws_connections"
  | "too_many_active_sessions"
  | "not_found_expired_or_used"
  | "session_device_or_origin_mismatch";

// Per-session, per-client, and global caps for authenticated traffic (#30,
// #126). The access rate
// limiter only guards the login gate; without these a single authenticated
// session could flood outbound SSH probes/tickets or open unbounded
// sockets/sessions, exhausting the broker's FDs, CPU, or memory. Conservative
// MVP defaults — the threat needs an already-authenticated, misbehaving session.
export const POST_AUTH_RATE_WINDOW_MS = 60 * 1000;
export const MAX_HOST_KEY_PROBES_PER_WINDOW = 30;
export const MAX_TICKETS_PER_WINDOW = 30;
export const MAX_ACCESS_SESSIONS_PER_CLIENT = 5;
const MAX_ACTIVE_SESSIONS_PER_CLIENT = 5;
const MAX_ACTIVE_WS_CONNECTIONS = 50;

// A device token is created 1:1 with its access session, so the access session
// id keys "per session/device" concurrency. Probe/ticket rate windows use both
// prefixed session ids and request IPs so logging in again cannot reset the
// budget. All live WebSocket connections share one global counter under this
// constant key.
const GLOBAL_WS_KEY = "global";

// Backpressure marks for the PTY->WS output stream (#19). Without them a flood
// like `yes` or `cat huge_file` outruns the socket: ws.bufferedAmount grows
// unbounded, ballooning server memory and freezing the browser tab. Pause the
// SSH channel once buffered output reaches the high mark and resume once the
// socket drains to the low mark. Conservative MVP byte budgets.
const WS_OUTPUT_HIGH_WATER_MARK = 1024 * 1024;
const WS_OUTPUT_LOW_WATER_MARK = 256 * 1024;

// Inbound flow-control budget for one authenticated terminal connection (#77).
// The 64 KiB `maxPayload` only bounds a single frame; without these an
// authenticated client can flood messages faster than the SSH target/audit sink
// drains them, growing memory and hammering the event loop and disk. The caps
// are generous versus real interactive use — fast typing is tens of frames/sec
// and a paste is one <=64 KiB frame — so legitimate traffic never trips them,
// while a sustained flood is closed with a `terminal_flood` audit event.
const INBOUND_WINDOW_MS = 1000;
const MAX_INBOUND_MESSAGES_PER_WINDOW = 512;
const MAX_INBOUND_BYTES_PER_WINDOW = 2 * 1024 * 1024;
// Bytes of unsent input held while the SSH channel pushes back before the
// backlog counts as sustained overflow and the connection is closed.
const MAX_QUEUED_INPUT_BYTES = 1024 * 1024;

type AuthenticatedRequest = {
  session: AccessSession;
  deviceToken: string;
};

function safeEqualText(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

const UPGRADE_STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  409: "Conflict",
  429: "Too Many Requests",
};

const ROUTE_NOT_FOUND_BODY = {
  error: "Not Found",
  message: "Route not found.",
  statusCode: 404,
} as const;
const RESERVED_SERVER_PATHS = ["/api", "/health", "/terminal"] as const;

function rejectUpgrade(socket: Duplex, statusCode: number): void {
  const statusText = UPGRADE_STATUS_TEXT[statusCode] ?? "Forbidden";
  socket.write(`HTTP/1.1 ${statusCode} ${statusText}\r\n\r\n`);
  socket.destroy();
}

function normalizeOriginHeader(
  origin: string | string[] | undefined,
): string | undefined {
  return Array.isArray(origin) ? origin[0] : origin;
}

function requestOrigin(request: FastifyRequest): string | undefined {
  return normalizeOriginHeader(request.headers.origin);
}

function normalizePolicyPathname(
  encodedPathname: string,
): string | undefined {
  try {
    // Compare URL path semantics, not literal static filenames: decode encoded
    // separators, normalize backslashes, and restore exactly one leading slash.
    const decodedPathname = decodeURIComponent(encodedPathname).replaceAll(
      "\\",
      "/",
    );
    return `/${decodedPathname.replace(/^\/+/u, "")}`;
  } catch {
    return undefined;
  }
}

function decodeRequestPathname(requestUrl: string): string | undefined {
  // find-my-way ends routing at the earliest raw delimiter. Split first so an
  // encoded delimiter such as %23 remains pathname data after decoding.
  let pathnameEnd = requestUrl.length;
  for (const delimiter of ["?", "#"]) {
    const delimiterStart = requestUrl.indexOf(delimiter);
    if (delimiterStart !== -1 && delimiterStart < pathnameEnd) {
      pathnameEnd = delimiterStart;
    }
  }
  return normalizePolicyPathname(requestUrl.slice(0, pathnameEnd));
}

function hasHiddenPathSegment(pathname: string): boolean {
  return pathname
    .split(/[\\/]/u)
    .some((segment) => segment.startsWith("."));
}

function isReservedServerPath(pathname: string): boolean {
  return RESERVED_SERVER_PATHS.some(
    (namespace) =>
      pathname === namespace || pathname.startsWith(`${namespace}/`),
  );
}

function consumePostAuthBudget(
  limiter: InMemoryFixedWindowRateLimiter,
  sessionId: string,
  clientIp: string,
) {
  return limiter.tryConsumeAll([`session:${sessionId}`, `client:${clientIp}`]);
}

function authenticateFastifyRequest(
  request: FastifyRequest,
  stores: Stores,
): AuthenticatedRequest | null {
  const cookies = readAuthCookies(request);
  const session = stores.accessCredentials.validate(
    cookies.sessionId,
    cookies.sessionToken,
    cookies.deviceToken,
  );
  if (!session) return null;
  return { session, deviceToken: cookies.deviceToken ?? "" };
}

function profileFromBody(
  body: z.infer<typeof terminalTicketSchema>,
  pinnedAddress: string | undefined,
): SshConnectionProfile {
  const profile: SshConnectionProfile = {
    host: body.host,
    port: body.port,
    username: body.username,
    privateKey: body.privateKey,
    acceptedHostFingerprint: body.acceptedHostFingerprint,
  };
  if (body.passphrase) profile.passphrase = body.passphrase;
  if (pinnedAddress) profile.pinnedAddress = pinnedAddress;
  return profile;
}

export type ServerDependencies = {
  // Injected so tests can drive a runtime sink failure through the real
  // handlers; production builds the configured file/stdout audit logger.
  audit?: AuditLogger;
  // Injected state lets HTTP-boundary tests assert the live session/device
  // cardinality after adversarial successful-login rotation.
  accessCredentials?: InMemoryAccessCredentialStore;
  // Injected so the rotation regression can inspect the production limiter
  // through its expiry contract without exposing server internals.
  ticketRateLimiter?: InMemoryFixedWindowRateLimiter;
  // Test seams for proving slot reclamation without waiting for the production
  // heartbeat or opening all 50 production slots.
  websocketHeartbeatIntervalMs?: number;
  maxActiveWsConnections?: number;
  maxActiveSessionsPerClient?: number;
};

export async function createOmxtermServer(
  config: ServerConfig,
  deps: ServerDependencies = {},
): Promise<FastifyInstance> {
  // Build the audit sink first so an unwritable configured path fails fast here
  // — before any timer or store is allocated — instead of throwing out of a
  // request/upgrade handler at runtime (#79).
  const audit =
    deps.audit ?? new JsonlAuditLogger(createAuditSink(config.auditLogPath));
  const stores: Stores = {
    accessCredentials:
      deps.accessCredentials ??
      new InMemoryAccessCredentialStore(
        systemClock,
        12 * 60 * 60 * 1000,
        MAX_ACCESS_SESSIONS_PER_CLIENT,
      ),
    tickets: new InMemoryTerminalTicketStore(),
    accessGrantAuditLimiter: new InMemoryFixedWindowRateLimiter(
      systemClock,
      MAX_ACCESS_GRANT_AUDITS_PER_DIRECT_PEER_PER_WINDOW,
      ACCESS_GRANT_AUDIT_WINDOW_MS,
    ),
    unauthenticatedRejectionAuditLimiter: new InMemoryFixedWindowRateLimiter(
      systemClock,
      MAX_UNAUTHENTICATED_REJECTION_AUDITS_PER_REASON_PER_WINDOW,
      UNAUTHENTICATED_REJECTION_AUDIT_WINDOW_MS,
    ),
    authenticatedWsRejectionAuditLimiter: new InMemoryFixedWindowRateLimiter(
      systemClock,
      MAX_AUTHENTICATED_WS_REJECTION_AUDITS_PER_REASON_PER_WINDOW,
      AUTHENTICATED_WS_UPGRADE_WINDOW_MS,
    ),
    accessRateLimiter: new InMemoryAccessRateLimiter(
      systemClock,
      ACCESS_GATE_MAX_FAILURES,
      ACCESS_GATE_WINDOW_MS,
    ),
    hostKeyRateLimiter: new InMemoryFixedWindowRateLimiter(
      systemClock,
      MAX_HOST_KEY_PROBES_PER_WINDOW,
      POST_AUTH_RATE_WINDOW_MS,
    ),
    ticketRateLimiter:
      deps.ticketRateLimiter ??
      new InMemoryFixedWindowRateLimiter(
        systemClock,
        MAX_TICKETS_PER_WINDOW,
        POST_AUTH_RATE_WINDOW_MS,
      ),
    wsUpgradeRateLimiter: new InMemoryFixedWindowRateLimiter(
      systemClock,
      MAX_AUTHENTICATED_WS_UPGRADE_ATTEMPTS_PER_WINDOW,
      AUTHENTICATED_WS_UPGRADE_WINDOW_MS,
    ),
    sessionConcurrency: new InMemoryConcurrencyLimiter(
      deps.maxActiveSessionsPerClient ?? MAX_ACTIVE_SESSIONS_PER_CLIENT,
    ),
    wsConcurrency: new InMemoryConcurrencyLimiter(
      deps.maxActiveWsConnections ?? MAX_ACTIVE_WS_CONNECTIONS,
    ),
  };
  // Reclaim expired entries (and the SSH key an unconsumed ticket holds) even
  // while the server is idle, instead of only on the next store read (#29). The
  // post-auth limiters are keyed by per-login session ids and the access limiter
  // by client IP, so their elapsed windows never get touched again and only the
  // sweep reclaims them (#39 for session keys, #78 for rotating client IPs).
  const stopExpirySweeper = startExpirySweeper(
    [
      stores.tickets,
      stores.accessCredentials,
      stores.accessGrantAuditLimiter,
      stores.unauthenticatedRejectionAuditLimiter,
      stores.authenticatedWsRejectionAuditLimiter,
      stores.accessRateLimiter,
      stores.hostKeyRateLimiter,
      stores.ticketRateLimiter,
      stores.wsUpgradeRateLimiter,
    ],
    EXPIRY_SWEEP_INTERVAL_MS,
  );
  const codec = createJsonTerminalProtocolCodec();
  // trustProxy lets Fastify read X-Forwarded-* behind a reverse proxy (Traefik),
  // so request.ip is the real client (the access rate limiter keys on it) and
  // proto/secure detection works. It defaults to false to avoid honoring
  // spoofable headers on a directly exposed server (#5).
  const app = Fastify({ logger: false, trustProxy: config.trustProxy });
  await app.register(helmet);
  await app.register(cookie);
  // Serve the built SPA from the broker in production so it shares the API's
  // origin (#52). Server-owned namespaces stay authoritative, and hidden path
  // segments are rejected before static serving or client-route fallback.
  // Unset in dev, where Vite serves the web and proxies the API.
  if (config.webRoot) {
    // allowedPath denials call the not-found handler. Retain only request
    // identity so the SPA fallback cannot turn a denied static path into 200.
    const deniedStaticRequests = new WeakSet<FastifyRequest>();
    app.addHook("onRequest", async (request, reply) => {
      const requestPath = decodeRequestPathname(request.url);
      if (requestPath === undefined || hasHiddenPathSegment(requestPath)) {
        return reply.code(404).send(ROUTE_NOT_FOUND_BODY);
      }
    });
    await app.register(fastifyStatic, {
      root: config.webRoot,
      dotfiles: "deny",
      allowedPath: (pathname, _root, request) => {
        const policyPath = decodeRequestPathname(pathname);
        const allowed =
          policyPath !== undefined &&
          !hasHiddenPathSegment(policyPath) &&
          !isReservedServerPath(policyPath);
        if (!allowed) deniedStaticRequests.add(request);
        return allowed;
      },
    });
    app.setNotFoundHandler((request, reply) => {
      const requestPath = decodeRequestPathname(request.url);
      if (
        !deniedStaticRequests.has(request) &&
        requestPath !== undefined &&
        !hasHiddenPathSegment(requestPath) &&
        !isReservedServerPath(requestPath) &&
        (request.method === "GET" || request.method === "HEAD")
      ) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send(ROUTE_NOT_FOUND_BODY);
    });
  }
  app.addHook("onClose", async () => {
    stopExpirySweeper();
  });

  function auditBoundedUnauthenticatedRejection(
    event: "access_rejected" | "ws_upgrade_rejected",
    directPeer: string,
    reason: BoundedUnauthenticatedRejectionReason,
  ): void {
    const auditKey = `${reason}\0${directPeer}`;
    if (
      !stores.unauthenticatedRejectionAuditLimiter.tryConsume(auditKey).allowed
    ) {
      return;
    }
    audit.write({ event, severity: "warn", reason });
  }

  // SSRF egress guard (#4): resolve the target and reject before any SSH dial
  // when an allowlist is configured. On block it audits and returns
  // `{ blocked: true }`; on allow it returns the validated IP to pin into the
  // dial — dialing that exact address instead of letting ssh2 re-resolve closes
  // the DNS-rebinding window between this check and the dial (#26). Unrestricted
  // mode resolves nothing, so there is no pin and the dial keeps using the
  // hostname (localhost demo).
  async function guardSshTarget(
    host: string,
    port: number,
    sessionId: string,
  ): Promise<{ blocked: true } | { blocked: false; pinnedAddress?: string }> {
    const decision = await checkSshEgress(
      host,
      config.sshEgressPolicy,
      resolveHostAddresses,
    );
    if (!decision.allowed) {
      audit.write({
        event: "ssh_egress_blocked",
        severity: "warn",
        sessionId,
        host,
        port,
        reason: decision.reason,
      });
      return { blocked: true };
    }
    // Pin the first validated address; the egress check already proved every
    // resolved address is in the allowlist. Probe and connect resolve
    // independently, so a multi-A-record host with distinct keys can pin
    // different IPs — the host-key fingerprint then mismatches and the connect
    // fails safe. Empty in unrestricted mode, where the dial keeps the hostname.
    const pinnedAddress = decision.addresses[0];
    return pinnedAddress
      ? { blocked: false, pinnedAddress }
      : { blocked: false };
  }

  function auditBoundedAuthenticatedWsRejection(
    sessionId: string,
    origin: string,
    directPeer: string,
    reason: BoundedAuthenticatedWsRejectionReason,
  ): void {
    const auditKey = `${reason}\0${directPeer}`;
    if (
      !stores.authenticatedWsRejectionAuditLimiter.tryConsume(auditKey).allowed
    ) {
      return;
    }
    audit.write({
      event: "ws_upgrade_rejected",
      severity: "warn",
      sessionId,
      origin,
      reason,
    });
  }

  app.get("/health", async () => ({ ok: true }));

  app.post(
    "/api/access",
    { bodyLimit: ACCESS_REQUEST_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const origin = requestOrigin(request);
      if (!isOriginAllowed(origin, config.allowedOrigins)) {
        auditBoundedUnauthenticatedRejection(
          "access_rejected",
          request.socket.remoteAddress ?? "unknown",
          "bad_origin",
        );
        return reply.code(403).send({ ok: false, message: "Bad Origin." });
      }

      // request.ip is the real client when OMXTERM_TRUST_PROXY is set behind a
      // reverse proxy; otherwise it is the socket peer. Without trustProxy in a
      // proxied deploy all clients would share the proxy's IP bucket (#5).
      const clientKey = request.ip;
      const decision = stores.accessRateLimiter.check(clientKey);
      if (!decision.allowed) {
        auditBoundedUnauthenticatedRejection(
          "access_rejected",
          request.socket.remoteAddress ?? "unknown",
          "rate_limited",
        );
        return reply
          .code(429)
          .header("retry-after", Math.ceil(decision.retryAfterMs / 1000))
          .send({ ok: false, message: "Too many attempts. Try again later." });
      }

      const parsed = accessSchema.safeParse(request.body);
      if (
        !parsed.success ||
        !safeEqualText(parsed.data.accessToken, config.accessToken)
      ) {
        stores.accessRateLimiter.recordFailure(clientKey);
        audit.write({
          event: "access_rejected",
          severity: "warn",
          origin,
          reason: "invalid_access_token",
        });
        return reply
          .code(401)
          .send({ ok: false, message: "Invalid access token." });
      }

      stores.accessRateLimiter.reset(clientKey);
      const { rawSessionToken, rawDeviceToken, session } =
        stores.accessCredentials.create(clientKey);
      setAuthCookies(
        reply,
        {
          sessionId: session.id,
          sessionToken: rawSessionToken,
          deviceToken: rawDeviceToken,
        },
        { secure: config.secureCookies },
      );
      const directPeer = request.socket.remoteAddress ?? "unknown";
      if (stores.accessGrantAuditLimiter.tryConsume(directPeer).allowed) {
        audit.write({
          event: "access_granted",
          severity: "info",
          sessionId: session.id,
          origin,
        });
      }
      return { ok: true };
    },
  );

  app.get("/api/me", async (request, reply) => {
    const origin = requestOrigin(request);
    // Same-origin browser GET fetches commonly omit Origin; keep rejecting an
    // explicitly bad Origin while allowing the boot-time auth probe.
    if (
      origin !== undefined &&
      !isOriginAllowed(origin, config.allowedOrigins)
    ) {
      return reply.code(403).send({ ok: false, message: "Bad Origin." });
    }
    const auth = authenticateFastifyRequest(request, stores);
    return { authenticated: Boolean(auth) };
  });

  app.post(
    "/api/ssh/host-key",
    { bodyLimit: HOST_KEY_REQUEST_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const origin = requestOrigin(request);
      if (!isOriginAllowed(origin, config.allowedOrigins)) {
        return reply.code(403).send({ ok: false, message: "Bad Origin." });
      }
      const auth = authenticateFastifyRequest(request, stores);
      if (!auth)
        return reply.code(401).send({ ok: false, message: "Unauthorized." });

      const rate = consumePostAuthBudget(
        stores.hostKeyRateLimiter,
        auth.session.id,
        request.ip,
      );
      if (!rate.allowed) {
        audit.write({
          event: "host_key_rejected",
          severity: "warn",
          sessionId: auth.session.id,
          reason: "rate_limited",
        });
        return reply
          .code(429)
          .header("retry-after", Math.ceil(rate.retryAfterMs / 1000))
          .send({
            ok: false,
            message: "Too many host-key probes. Try again later.",
          });
      }

      const parsed = hostKeySchema.safeParse(request.body);
      if (!parsed.success)
        return reply
          .code(400)
          .send({ ok: false, message: "Invalid SSH target." });

      const egress = await guardSshTarget(
        parsed.data.host,
        parsed.data.port,
        auth.session.id,
      );
      if (egress.blocked)
        return reply
          .code(403)
          .send({ ok: false, message: "SSH target is not allowed." });

      try {
        const result = await probeSshHostKey(
          egress.pinnedAddress
            ? { ...parsed.data, pinnedAddress: egress.pinnedAddress }
            : parsed.data,
        );
        audit.write({
          event: "host_key_presented",
          severity: "info",
          sessionId: auth.session.id,
          host: parsed.data.host,
          port: parsed.data.port,
        });
        return { ok: true, fingerprint: result.fingerprint };
      } catch (error) {
        // Network/handshake failures (unreachable host, refused/timed-out
        // connect, hairpin routing gaps) were previously discarded here, so a
        // failing probe left no trace in the audit log at all.
        audit.write({
          event: "host_key_probe_failed",
          severity: "warn",
          sessionId: auth.session.id,
          host: parsed.data.host,
          port: parsed.data.port,
          reason: normalizeHostKeyProbeFailure(error),
        });
        return reply
          .code(502)
          .send({ ok: false, message: "Could not read SSH host key." });
      }
    },
  );

  app.post(
    "/api/terminal-ticket",
    { bodyLimit: TERMINAL_TICKET_REQUEST_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const origin = requestOrigin(request);
      if (!isOriginAllowed(origin, config.allowedOrigins)) {
        return reply.code(403).send({ ok: false, message: "Bad Origin." });
      }
      const auth = authenticateFastifyRequest(request, stores);
      if (!auth)
        return reply.code(401).send({ ok: false, message: "Unauthorized." });

      const rate = consumePostAuthBudget(
        stores.ticketRateLimiter,
        auth.session.id,
        request.ip,
      );
      if (!rate.allowed) {
        audit.write({
          event: "ticket_rejected",
          severity: "warn",
          sessionId: auth.session.id,
          reason: "rate_limited",
        });
        return reply
          .code(429)
          .header("retry-after", Math.ceil(rate.retryAfterMs / 1000))
          .send({
            ok: false,
            message: "Too many ticket requests. Try again later.",
          });
      }

      const parsed = terminalTicketSchema.safeParse(request.body);
      if (!parsed.success)
        return reply
          .code(400)
          .send({ ok: false, message: "Invalid SSH connection profile." });

      const egress = await guardSshTarget(
        parsed.data.host,
        parsed.data.port,
        auth.session.id,
      );
      if (egress.blocked)
        return reply
          .code(403)
          .send({ ok: false, message: "SSH target is not allowed." });

      const profile = profileFromBody(parsed.data, egress.pinnedAddress);
      const issued = stores.tickets.issue({
        sessionId: auth.session.id,
        rawDeviceToken: auth.deviceToken,
        origin: origin ?? "",
        profile,
      });
      audit.write({
        event: "ticket_issued",
        severity: "info",
        sessionId: auth.session.id,
        origin,
        host: profile.host,
        port: profile.port,
      });
      audit.write({
        event: "host_key_trusted",
        severity: "info",
        sessionId: auth.session.id,
        host: profile.host,
        port: profile.port,
      });
      return {
        ok: true,
        ticket: issued.rawTicket,
        wsUrl: "/terminal/ws",
        expiresInSeconds: 60,
      };
    },
  );

  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: 64 * 1024,
  });
  app.addHook("preClose", async () => {
    // Upgraded sockets are outside Fastify's request lifecycle. Terminate them
    // before close resolves so each normal WebSocket close path tears down its
    // SSH session and finishes audit writes before deployment can replace the
    // process or a test can remove its sink.
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  app.server.on("upgrade", (req, socket, head) => {
    let origin: string | undefined;
    let sessionId: string | undefined;
    let globalSlotAcquired = false;
    let sessionSlotAcquired = false;
    let slotsReleased = false;
    const releaseConnectionSlots = () => {
      if (slotsReleased) return;
      slotsReleased = true;
      if (sessionSlotAcquired && sessionId) {
        stores.sessionConcurrency.release(sessionId);
      }
      if (globalSlotAcquired) stores.wsConcurrency.release(GLOBAL_WS_KEY);
    };

    try {
      origin = normalizeOriginHeader(req.headers.origin);
      const upgradeId = randomUUID();
      if (!isOriginAllowed(origin, config.allowedOrigins)) {
        auditBoundedUnauthenticatedRejection(
          "ws_upgrade_rejected",
          req.socket.remoteAddress ?? "unknown",
          "bad_origin",
        );
        rejectUpgrade(socket, 403);
        return;
      }

      const url = new URL(req.url ?? "/", origin);
      if (url.pathname !== "/terminal/ws") {
        rejectUpgrade(socket, 403);
        return;
      }

      const cookies = parseCookieHeader(req.headers.cookie);
      const deviceToken = cookies[DEVICE_TOKEN_COOKIE];
      const session = stores.accessCredentials.validate(
        cookies[SESSION_ID_COOKIE],
        cookies[SESSION_TOKEN_COOKIE],
        deviceToken,
      );
      const rawTicket = url.searchParams.get("ticket");
      if (!session || !deviceToken || !rawTicket) {
        auditBoundedUnauthenticatedRejection(
          "ws_upgrade_rejected",
          req.socket.remoteAddress ?? "unknown",
          "missing_auth_or_ticket",
        );
        rejectUpgrade(socket, 401);
        return;
      }
      const activeSessionId = session.id;
      sessionId = activeSessionId;
      const directPeer = req.socket.remoteAddress ?? "unknown";
      const upgradeRate = stores.wsUpgradeRateLimiter.tryConsumeAll([
        `session:${activeSessionId}`,
        `peer:${directPeer}`,
      ]);
      if (!upgradeRate.allowed) {
        auditBoundedAuthenticatedWsRejection(
          activeSessionId,
          origin,
          directPeer,
          "rate_limited",
        );
        rejectUpgrade(socket, 429);
        return;
      }

      // Cap concurrent connections before consuming the single-use ticket (#30), so
      // a capacity rejection doesn't burn the ticket the user just minted. Acquire
      // the global slot first, then the per-session one, releasing the global if the
      // per-session cap is hit.
      if (!stores.wsConcurrency.tryAcquire(GLOBAL_WS_KEY)) {
        auditBoundedAuthenticatedWsRejection(
          activeSessionId,
          origin,
          directPeer,
          "too_many_ws_connections",
        );
        rejectUpgrade(socket, 409);
        return;
      }
      globalSlotAcquired = true;
      if (!stores.sessionConcurrency.tryAcquire(activeSessionId)) {
        releaseConnectionSlots();
        auditBoundedAuthenticatedWsRejection(
          activeSessionId,
          origin,
          directPeer,
          "too_many_active_sessions",
        );
        rejectUpgrade(socket, 409);
        return;
      }
      sessionSlotAcquired = true;

      // Free both slots exactly once when the connection ends. Bound to the raw
      // socket's "close" so it also covers an upgrade that never reaches the
      // "connection" event (e.g. the client aborts mid-handshake), not just a
      // normal WebSocket close.
      socket.on("close", releaseConnectionSlots);

      const grant = stores.tickets.consume({
        rawTicket,
        sessionId: activeSessionId,
        deviceToken,
        origin,
      });
      if (!grant.ok) {
        releaseConnectionSlots();
        auditBoundedAuthenticatedWsRejection(
          activeSessionId,
          origin,
          directPeer,
          grant.reason,
        );
        rejectUpgrade(socket, 403);
        return;
      }

      audit.write({
        event: "ticket_consumed",
        severity: "info",
        sessionId,
        origin,
      });
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req, {
          session,
          grant: grant.grant,
          upgradeId,
        });
      });
    } catch {
      releaseConnectionSlots();
      auditBoundedUnauthenticatedRejection(
        "ws_upgrade_rejected",
        req.socket.remoteAddress ?? "unknown",
        "upgrade_error",
      );
      rejectUpgrade(socket, 400);
    }
  });

  wss.on(
    "connection",
    (
      ws: WebSocket,
      _req: unknown,
      context: {
        session: AccessSession;
        grant: { profile: SshConnectionProfile };
        upgradeId: string;
      },
    ) => {
      const terminal = new SshTerminalSession();
      const terminalSessionId = context.upgradeId;
      let bytesIn = 0;
      let bytesOut = 0;
      let closed = false;
      let stopHeartbeat = () => {};

      // Pause the SSH channel when the socket's send buffer backs up, resume when
      // it drains, so a flood can't outrun the client and freeze the tab (#19).
      const backpressure = createOutputBackpressure({
        highWaterMark: WS_OUTPUT_HIGH_WATER_MARK,
        lowWaterMark: WS_OUTPUT_LOW_WATER_MARK,
        pause: () => terminal.pause(),
        resume: () => terminal.resume(),
      });

      const send = (
        message: Parameters<typeof codec.encodeServerMessage>[0],
      ) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const encoded = codec.encodeServerMessage(message);
        bytesOut += Buffer.byteLength(encoded);
        // Resume once this frame finishes flushing; pause synchronously if
        // enqueuing it pushed the socket past the high-water mark (#19).
        ws.send(encoded, () => backpressure.observe(ws.bufferedAmount));
        backpressure.observe(ws.bufferedAmount);
      };

      // Bound inbound terminal traffic so an authenticated client cannot outrun
      // the SSH target or audit sink (#77): a per-connection byte/message budget
      // that closes on a flood, a strictly bounded input queue that honors SSH
      // write backpressure, and coalesced resizes that avoid synchronous audit
      // amplification. Legitimate typing, paste, resize, and Ctrl-C pass through.
      const inbound = createTerminalInboundGuard({
        limits: {
          windowMs: INBOUND_WINDOW_MS,
          maxMessagesPerWindow: MAX_INBOUND_MESSAGES_PER_WINDOW,
          maxBytesPerWindow: MAX_INBOUND_BYTES_PER_WINDOW,
          maxQueuedInputBytes: MAX_QUEUED_INPUT_BYTES,
        },
        now: () => Date.now(),
        scheduleResizeFlush: (flush) => {
          setImmediate(flush);
        },
        parseFrame: (text) => codec.parseClientMessage(text),
        writeInput: (data) => terminal.write(data),
        subscribeDrain: (listener) => {
          terminal.on("drain", listener);
          return () => terminal.off("drain", listener);
        },
        applyResize: (cols, rows) => {
          terminal.resize(cols, rows);
          audit.write({
            event: "resize",
            severity: "info",
            sessionId: context.session.id,
            cols,
            rows,
          });
        },
        sendMessage: send,
        onOverflow: (reason) => {
          audit.write({
            event: "terminal_flood",
            severity: "warn",
            sessionId: context.session.id,
            reason,
          });
          if (ws.readyState === WebSocket.OPEN) ws.close(1008, "inbound_flood");
        },
      });

      const closeTerminalSession = (
        reason:
          | "websocket_closed"
          | "websocket_error"
          | "websocket_heartbeat_timeout",
        severity: "info" | "warn",
      ) => {
        if (closed) return;
        closed = true;
        stopHeartbeat();
        inbound.dispose();
        // terminal.close() aborts a still-pending SSH establishment attempt;
        // that boundary owns and releases its authentication references before
        // the cancellation settles.
        terminal.close();
        audit.write({
          event: "session_ended",
          severity,
          sessionId: context.session.id,
          bytesIn,
          bytesOut,
          reason,
        });
      };

      terminal.on("output", (data) => {
        send({ type: "output", data });
      });
      terminal.on("error", () => {
        send({
          type: "error",
          code: "ssh_error",
          message: "The SSH session failed.",
        });
      });
      terminal.on("close", (reason) => {
        if (closed) return;
        send({ type: "exit", reason });
        ws.close(1000, reason);
      });

      ws.on("message", (raw) => {
        const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
        bytesIn += Buffer.byteLength(text);
        inbound.handleFrame(text);
      });

      stopHeartbeat = startWebSocketHeartbeat({
        socket: ws,
        ...(deps.websocketHeartbeatIntervalMs === undefined
          ? {}
          : { intervalMs: deps.websocketHeartbeatIntervalMs }),
        onTimeout: () => {
          closeTerminalSession("websocket_heartbeat_timeout", "warn");
          ws.terminate();
        },
      });

      ws.on("error", () => {
        closeTerminalSession("websocket_error", "warn");
        ws.terminate();
      });

      ws.on("close", () => closeTerminalSession("websocket_closed", "info"));

      // connect() consumes the one-attempt profile. Capture only audit-safe
      // metadata before transfer and never read or mutate the profile afterward.
      const targetHost = context.grant.profile.host;
      const targetPort = context.grant.profile.port;
      void terminal
        .connect(context.grant.profile, { cols: 120, rows: 34 })
        .then(() => {
          audit.write({
            event: "session_started",
            severity: "info",
            sessionId: context.session.id,
            host: targetHost,
            port: targetPort,
          });
          send({ type: "ready", sessionId: terminalSessionId });
        })
        .catch((error: unknown) => {
          audit.write({
            event: "session_connect_failed",
            severity: "warn",
            sessionId: context.session.id,
            host: targetHost,
            port: targetPort,
            reason:
              error instanceof SshConnectError
                ? error.reason
                : "ssh_connect_failed",
          });
          send({
            type: "error",
            code: "ssh_connect_failed",
            message: "Could not open the SSH session.",
          });
          ws.close(1011, "ssh_connect_failed");
        });
    },
  );

  return app;
}
