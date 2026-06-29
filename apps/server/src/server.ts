import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import { createJsonTerminalProtocolCodec } from "@omxterm/core/protocol";
import {
  InMemoryAccessRateLimiter,
  InMemoryAccessSessionStore,
  InMemoryDeviceTokenStore,
  InMemoryTerminalTicketStore,
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
};

// How often the active expiry sweeper runs (#29). The cadence is driven by the
// most sensitive store: terminal tickets carry the SSH private key on a 60s TTL,
// so sweeping every 10s caps how long an unconsumed key can linger past expiry.
// Sessions/devices (12h TTL) ride the same sweep cheaply.
const EXPIRY_SWEEP_INTERVAL_MS = 10 * 1000;

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

function rejectUpgrade(socket: Duplex, statusCode: number): void {
  socket.write(
    `HTTP/1.1 ${statusCode} ${statusCode === 401 ? "Unauthorized" : "Forbidden"}\r\n\r\n`,
  );
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
): SshConnectionProfile {
  const profile: SshConnectionProfile = {
    host: body.host,
    port: body.port,
    username: body.username,
    privateKey: body.privateKey,
    acceptedHostFingerprint: body.acceptedHostFingerprint,
  };
  if (body.passphrase) profile.passphrase = body.passphrase;
  return profile;
}

export async function createOmxtermServer(
  config: ServerConfig,
): Promise<FastifyInstance> {
  const stores: Stores = {
    sessions: new InMemoryAccessSessionStore(),
    devices: new InMemoryDeviceTokenStore(),
    tickets: new InMemoryTerminalTicketStore(),
    accessRateLimiter: new InMemoryAccessRateLimiter(),
  };
  // Reclaim expired entries (and the SSH key an unconsumed ticket holds) even
  // while the server is idle, instead of only on the next store read (#29).
  const stopExpirySweeper = startExpirySweeper(
    [stores.tickets, stores.sessions, stores.devices],
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
  app.addHook("onClose", async () => {
    stopExpirySweeper();
  });

  // SSRF egress guard (#4): resolve the target and reject before any SSH dial
  // when an allowlist is configured. Returns true when the target is blocked
  // (and the rejection was audited), false when it may proceed.
  async function isSshTargetBlocked(
    host: string,
    port: number,
    sessionId: string,
  ): Promise<boolean> {
    const decision = await checkSshEgress(
      host,
      config.sshEgressPolicy,
      resolveHostAddresses,
    );
    if (decision.allowed) return false;
    audit.write({
      event: "ssh_egress_blocked",
      severity: "warn",
      sessionId,
      host,
      port,
      reason: decision.reason,
    });
    return true;
  }

  app.get("/health", async () => ({ ok: true }));

  app.post("/api/access", async (request, reply) => {
    // request.ip is the real client when OMXTERM_TRUST_PROXY is set behind a
    // reverse proxy; otherwise it is the socket peer. Without trustProxy in a
    // proxied deploy all clients would share the proxy's IP bucket (#5).
    const clientKey = request.ip;
    const decision = stores.accessRateLimiter.check(clientKey);
    if (!decision.allowed) {
      audit.write({
        event: "access_rejected",
        severity: "warn",
        origin: requestOrigin(request),
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
        origin: requestOrigin(request),
        reason: "invalid_access_token",
      });
      return reply
        .code(401)
        .send({ ok: false, message: "Invalid access token." });
    }

    stores.accessRateLimiter.reset(clientKey);
    const { rawSessionToken, session } = stores.sessions.create();
    const device = stores.devices.create(session.id);
    setAuthCookies(
      reply,
      {
        sessionId: session.id,
        sessionToken: rawSessionToken,
        deviceToken: device.raw,
      },
      { secure: config.secureCookies },
    );
    audit.write({
      event: "access_granted",
      severity: "info",
      sessionId: session.id,
      origin: requestOrigin(request),
    });
    return { ok: true };
  });

  app.get("/api/me", async (request) => {
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

    const parsed = hostKeySchema.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ ok: false, message: "Invalid SSH target." });

    if (
      await isSshTargetBlocked(
        parsed.data.host,
        parsed.data.port,
        auth.session.id,
      )
    )
      return reply
        .code(403)
        .send({ ok: false, message: "SSH target is not allowed." });

    try {
      const result = await probeSshHostKey(parsed.data);
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

    const parsed = terminalTicketSchema.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ ok: false, message: "Invalid SSH connection profile." });

    if (
      await isSshTargetBlocked(
        parsed.data.host,
        parsed.data.port,
        auth.session.id,
      )
    )
      return reply
        .code(403)
        .send({ ok: false, message: "SSH target is not allowed." });

    const profile = profileFromBody(parsed.data);
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

    const grant = stores.tickets.consume({
      rawTicket,
      sessionId: session.id,
      deviceToken,
      origin,
    });
    if (!grant.ok) {
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

      const send = (
        message: Parameters<typeof codec.encodeServerMessage>[0],
      ) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const encoded = codec.encodeServerMessage(message);
        bytesOut += Buffer.byteLength(encoded);
        ws.send(encoded);
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
