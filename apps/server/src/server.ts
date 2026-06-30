import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import fastifyStatic from "@fastify/static";
import { createJsonTerminalProtocolCodec } from "@omxterm/core/protocol";
import {
  InMemoryAccessRateLimiter,
  InMemoryAccessSessionStore,
  InMemoryConcurrencyLimiter,
  InMemoryDeviceTokenStore,
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
import { JsonlAuditLogger } from "./audit-logger";
import { probeSshHostKey, SshTerminalSession } from "./ssh";
import { checkSshEgress, resolveHostAddresses } from "./ssh-egress-policy";
import { createOutputBackpressure } from "./terminal-backpressure";

const accessSchema = z.object({ accessToken: z.string().min(1).max(4096) });
const hostKeySchema = z.object({
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(22),
});
const terminalTicketSchema = z.object({
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1).max(128),
  privateKey: z
    .string()
    .min(1)
    .max(64 * 1024),
  passphrase: z.string().max(4096).optional(),
  acceptedHostFingerprint: z.string().min(1).max(256),
});

type Stores = {
  sessions: InMemoryAccessSessionStore;
  devices: InMemoryDeviceTokenStore;
  tickets: InMemoryTerminalTicketStore;
  accessRateLimiter: InMemoryAccessRateLimiter;
  hostKeyRateLimiter: InMemoryFixedWindowRateLimiter;
  ticketRateLimiter: InMemoryFixedWindowRateLimiter;
  sessionConcurrency: InMemoryConcurrencyLimiter;
  wsConcurrency: InMemoryConcurrencyLimiter;
};

// How often the active expiry sweeper runs (#29). The cadence is driven by the
// most sensitive store: terminal tickets carry the SSH private key on a 60s TTL,
// so sweeping every 10s caps how long an unconsumed key can linger past expiry.
// Sessions/devices (12h TTL) ride the same sweep cheaply.
const EXPIRY_SWEEP_INTERVAL_MS = 10 * 1000;

// Per-session and global caps for authenticated traffic (#30). The access rate
// limiter only guards the login gate; without these a single authenticated
// session could flood outbound SSH probes/tickets or open unbounded
// sockets/sessions, exhausting the broker's FDs, CPU, or memory. Conservative
// MVP defaults — the threat needs an already-authenticated, misbehaving session.
const POST_AUTH_RATE_WINDOW_MS = 60 * 1000;
const MAX_HOST_KEY_PROBES_PER_WINDOW = 30;
const MAX_TICKETS_PER_WINDOW = 30;
const MAX_ACTIVE_SESSIONS_PER_CLIENT = 5;
const MAX_ACTIVE_WS_CONNECTIONS = 50;

// A device token is created 1:1 with its access session, so the access session
// id keys "per session/device" concurrency. All live WebSocket connections share
// one global counter under this constant key.
const GLOBAL_WS_KEY = "global";

// Backpressure marks for the PTY->WS output stream (#19). Without them a flood
// like `yes` or `cat huge_file` outruns the socket: ws.bufferedAmount grows
// unbounded, ballooning server memory and freezing the browser tab. Pause the
// SSH channel once buffered output reaches the high mark and resume once the
// socket drains to the low mark. Conservative MVP byte budgets.
const WS_OUTPUT_HIGH_WATER_MARK = 1024 * 1024;
const WS_OUTPUT_LOW_WATER_MARK = 256 * 1024;

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
  401: "Unauthorized",
  403: "Forbidden",
  409: "Conflict",
};

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

function authenticateFastifyRequest(
  request: FastifyRequest,
  stores: Stores,
): AuthenticatedRequest | null {
  const cookies = readAuthCookies(request);
  const session = stores.sessions.validate(
    cookies.sessionId,
    cookies.sessionToken,
  );
  if (!session) return null;
  const device = stores.devices.validate(session.id, cookies.deviceToken);
  if (!device) return null;
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

export function scrubSshConnectionSecrets(profile: SshConnectionProfile): void {
  profile.privateKey = "";
  if (profile.passphrase !== undefined) profile.passphrase = "";
}

export async function createOmxtermServer(
  config: ServerConfig,
): Promise<FastifyInstance> {
  const stores: Stores = {
    sessions: new InMemoryAccessSessionStore(),
    devices: new InMemoryDeviceTokenStore(),
    tickets: new InMemoryTerminalTicketStore(),
    accessRateLimiter: new InMemoryAccessRateLimiter(),
    hostKeyRateLimiter: new InMemoryFixedWindowRateLimiter(
      systemClock,
      MAX_HOST_KEY_PROBES_PER_WINDOW,
      POST_AUTH_RATE_WINDOW_MS,
    ),
    ticketRateLimiter: new InMemoryFixedWindowRateLimiter(
      systemClock,
      MAX_TICKETS_PER_WINDOW,
      POST_AUTH_RATE_WINDOW_MS,
    ),
    sessionConcurrency: new InMemoryConcurrencyLimiter(
      MAX_ACTIVE_SESSIONS_PER_CLIENT,
    ),
    wsConcurrency: new InMemoryConcurrencyLimiter(MAX_ACTIVE_WS_CONNECTIONS),
  };
  // Reclaim expired entries (and the SSH key an unconsumed ticket holds) even
  // while the server is idle, instead of only on the next store read (#29). The
  // rate limiters are keyed by per-login session ids, so their elapsed windows
  // never get touched again and only the sweep reclaims them (#39).
  const stopExpirySweeper = startExpirySweeper(
    [
      stores.tickets,
      stores.sessions,
      stores.devices,
      stores.hostKeyRateLimiter,
      stores.ticketRateLimiter,
    ],
    EXPIRY_SWEEP_INTERVAL_MS,
  );
  const audit = new JsonlAuditLogger(config.auditLogPath);
  const codec = createJsonTerminalProtocolCodec();
  // trustProxy lets Fastify read X-Forwarded-* behind a reverse proxy (Traefik),
  // so request.ip is the real client (the access rate limiter keys on it) and
  // proto/secure detection works. It defaults to false to avoid honoring
  // spoofable headers on a directly exposed server (#5).
  const app = Fastify({ logger: false, trustProxy: config.trustProxy });
  await app.register(helmet);
  await app.register(cookie);
  // Serve the built SPA from the broker in production so it shares the API's
  // origin (#52). The /api routes and the /terminal/ws upgrade are matched
  // first, so this only answers the SPA shell and its assets. Unset in dev,
  // where Vite serves the web and proxies the API.
  if (config.webRoot) {
    await app.register(fastifyStatic, { root: config.webRoot });
  }
  app.addHook("onClose", async () => {
    stopExpirySweeper();
  });

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

  app.get("/health", async () => ({ ok: true }));

  app.post("/api/access", async (request, reply) => {
    const origin = requestOrigin(request);
    if (!isOriginAllowed(origin, config.allowedOrigins)) {
      audit.write({
        event: "access_rejected",
        severity: "warn",
        origin,
        reason: "bad_origin",
      });
      return reply.code(403).send({ ok: false, message: "Bad Origin." });
    }

    // request.ip is the real client when OMXTERM_TRUST_PROXY is set behind a
    // reverse proxy; otherwise it is the socket peer. Without trustProxy in a
    // proxied deploy all clients would share the proxy's IP bucket (#5).
    const clientKey = request.ip;
    const decision = stores.accessRateLimiter.check(clientKey);
    if (!decision.allowed) {
      audit.write({
        event: "access_rejected",
        severity: "warn",
        origin,
        reason: "rate_limited",
      });
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
    const { rawSessionToken, session } = stores.sessions.create();
    const { rawDeviceToken } = stores.devices.create(session.id);
    setAuthCookies(
      reply,
      {
        sessionId: session.id,
        sessionToken: rawSessionToken,
        deviceToken: rawDeviceToken,
      },
      { secure: config.secureCookies },
    );
    audit.write({
      event: "access_granted",
      severity: "info",
      sessionId: session.id,
      origin,
    });
    return { ok: true };
  });

  app.get("/api/me", async (request, reply) => {
    const origin = requestOrigin(request);
    // Same-origin browser GET fetches commonly omit Origin; keep rejecting an
    // explicitly bad Origin while allowing the boot-time auth probe.
    if (origin !== undefined && !isOriginAllowed(origin, config.allowedOrigins)) {
      return reply.code(403).send({ ok: false, message: "Bad Origin." });
    }
    const auth = authenticateFastifyRequest(request, stores);
    return { authenticated: Boolean(auth) };
  });

  app.post("/api/ssh/host-key", async (request, reply) => {
    const origin = requestOrigin(request);
    if (!isOriginAllowed(origin, config.allowedOrigins)) {
      return reply.code(403).send({ ok: false, message: "Bad Origin." });
    }
    const auth = authenticateFastifyRequest(request, stores);
    if (!auth)
      return reply.code(401).send({ ok: false, message: "Unauthorized." });

    const rate = stores.hostKeyRateLimiter.tryConsume(auth.session.id);
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
    } catch {
      return reply
        .code(502)
        .send({ ok: false, message: "Could not read SSH host key." });
    }
  });

  app.post("/api/terminal-ticket", async (request, reply) => {
    const origin = requestOrigin(request);
    if (!isOriginAllowed(origin, config.allowedOrigins)) {
      return reply.code(403).send({ ok: false, message: "Bad Origin." });
    }
    const auth = authenticateFastifyRequest(request, stores);
    if (!auth)
      return reply.code(401).send({ ok: false, message: "Unauthorized." });

    const rate = stores.ticketRateLimiter.tryConsume(auth.session.id);
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
  });

  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: 64 * 1024,
  });

  app.server.on("upgrade", (req, socket, head) => {
    const origin = normalizeOriginHeader(req.headers.origin);
    const upgradeId = randomUUID();
    if (!isOriginAllowed(origin, config.allowedOrigins)) {
      audit.write({
        event: "ws_upgrade_rejected",
        severity: "warn",
        origin,
        reason: "bad_origin",
      });
      rejectUpgrade(socket, 403);
      return;
    }

    const url = new URL(req.url ?? "/", origin);
    if (url.pathname !== "/terminal/ws") {
      rejectUpgrade(socket, 403);
      return;
    }

    const cookies = parseCookieHeader(req.headers.cookie);
    const session = stores.sessions.validate(
      cookies[SESSION_ID_COOKIE],
      cookies[SESSION_TOKEN_COOKIE],
    );
    const deviceToken = cookies[DEVICE_TOKEN_COOKIE];
    const device = stores.devices.validate(session?.id, deviceToken);
    const rawTicket = url.searchParams.get("ticket");
    if (!session || !device || !deviceToken || !rawTicket) {
      audit.write({
        event: "ws_upgrade_rejected",
        severity: "warn",
        origin,
        reason: "missing_auth_or_ticket",
      });
      rejectUpgrade(socket, 401);
      return;
    }

    // Cap concurrent connections before consuming the single-use ticket (#30), so
    // a capacity rejection doesn't burn the ticket the user just minted. Acquire
    // the global slot first, then the per-session one, releasing the global if the
    // per-session cap is hit.
    if (!stores.wsConcurrency.tryAcquire(GLOBAL_WS_KEY)) {
      audit.write({
        event: "ws_upgrade_rejected",
        severity: "warn",
        sessionId: session.id,
        origin,
        reason: "too_many_ws_connections",
      });
      rejectUpgrade(socket, 409);
      return;
    }
    if (!stores.sessionConcurrency.tryAcquire(session.id)) {
      stores.wsConcurrency.release(GLOBAL_WS_KEY);
      audit.write({
        event: "ws_upgrade_rejected",
        severity: "warn",
        sessionId: session.id,
        origin,
        reason: "too_many_active_sessions",
      });
      rejectUpgrade(socket, 409);
      return;
    }

    // Free both slots exactly once when the connection ends. Bound to the raw
    // socket's "close" so it also covers an upgrade that never reaches the
    // "connection" event (e.g. the client aborts mid-handshake), not just a
    // normal WebSocket close.
    let slotsReleased = false;
    const releaseConnectionSlots = () => {
      if (slotsReleased) return;
      slotsReleased = true;
      stores.sessionConcurrency.release(session.id);
      stores.wsConcurrency.release(GLOBAL_WS_KEY);
    };
    socket.on("close", releaseConnectionSlots);

    const grant = stores.tickets.consume({
      rawTicket,
      sessionId: session.id,
      deviceToken,
      origin,
    });
    if (!grant.ok) {
      releaseConnectionSlots();
      audit.write({
        event: "ws_upgrade_rejected",
        severity: "warn",
        sessionId: session.id,
        origin,
        reason: grant.reason,
      });
      rejectUpgrade(socket, 403);
      return;
    }

    audit.write({
      event: "ticket_consumed",
      severity: "info",
      sessionId: session.id,
      origin,
    });
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, {
        session,
        grant: grant.grant,
        upgradeId,
      });
    });
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
        send({ type: "exit", reason });
        ws.close(1000, reason);
      });

      ws.on("message", (raw) => {
        const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
        bytesIn += Buffer.byteLength(text);
        const parsed = codec.parseClientMessage(text);
        if (!parsed.ok) {
          send({ type: "error", code: parsed.code, message: parsed.message });
          return;
        }
        if (parsed.message.type === "input")
          terminal.write(parsed.message.data);
        if (parsed.message.type === "resize") {
          terminal.resize(parsed.message.cols, parsed.message.rows);
          audit.write({
            event: "resize",
            severity: "info",
            sessionId: context.session.id,
            cols: parsed.message.cols,
            rows: parsed.message.rows,
          });
        }
        if (parsed.message.type === "ping")
          send({ type: "pong", ts: parsed.message.ts });
      });

      ws.on("close", () => {
        if (closed) return;
        closed = true;
        terminal.close();
        audit.write({
          event: "session_ended",
          severity: "info",
          sessionId: context.session.id,
          bytesIn,
          bytesOut,
          reason: "websocket_closed",
        });
      });

      void terminal
        .connect(context.grant.profile, { cols: 120, rows: 34 })
        .then(() => {
          scrubSshConnectionSecrets(context.grant.profile);
          audit.write({
            event: "session_started",
            severity: "info",
            sessionId: context.session.id,
            host: context.grant.profile.host,
            port: context.grant.profile.port,
          });
          send({ type: "ready", sessionId: terminalSessionId });
        })
        .catch(() => {
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
