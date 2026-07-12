import type { AuditEvent, AuditLogger } from "@omxterm/core/audit";
import { generateKeyPairSync } from "node:crypto";
import { connect, createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import type { ServerConfig } from "./config";
import { createOmxtermServer } from "./server";

const config: ServerConfig = {
  accessToken: "strong-access-token-for-tests",
  allowedOrigins: ["https://omxterm.example"],
  host: "127.0.0.1",
  port: 0,
  secureCookies: true,
  trustProxy: false,
  sshEgressPolicy: { kind: "unrestricted" },
  auditLogPath: undefined,
  webRoot: undefined,
};

const discardAudit: AuditLogger = { write: () => {} };
const sockets = new Set<Socket>();
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

afterEach(() => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
});

function cookieHeader(setCookie: string | string[] | undefined): string {
  if (!setCookie) throw new Error("Expected login to set auth cookies.");
  const values = Array.isArray(setCookie) ? setCookie : [setCookie];
  return values.map((value) => value.split(";", 1)[0]).join("; ");
}

async function listenPort(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP listen address.");
  }
  return address.port;
}

async function issueTicket(
  app: Awaited<ReturnType<typeof createOmxtermServer>>,
  cookie: string,
  sshPort: number,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/terminal-ticket",
    headers: { origin: config.allowedOrigins[0], cookie },
    payload: {
      host: "127.0.0.1",
      port: sshPort,
      username: "test-user",
      privateKey,
      acceptedHostFingerprint: "SHA256:test",
    },
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ ticket: string }>().ticket;
}

function upgradeRequest(ticket: string, cookie: string): string {
  return [
    `GET /terminal/ws?ticket=${encodeURIComponent(ticket)} HTTP/1.1`,
    "Host: 127.0.0.1",
    "Connection: Upgrade",
    "Upgrade: websocket",
    "Sec-WebSocket-Version: 13",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    `Origin: ${config.allowedOrigins[0]}`,
    `Cookie: ${cookie}`,
    "",
    "",
  ].join("\r\n");
}

async function attemptUpgrade(
  port: number,
  ticket: string,
  cookie: string,
): Promise<{ response: string; socket: Socket }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    sockets.add(socket);
    let response = "";
    socket.on("connect", () => socket.write(upgradeRequest(ticket, cookie)));
    socket.on("data", function readHeaders(chunk) {
      response += chunk.toString("utf8");
      if (!response.includes("\r\n\r\n")) return;
      socket.off("data", readHeaders);
      resolve({ response, socket });
    });
    socket.on("error", reject);
  });
}

function waitForClose(socket: Socket, timeoutMs = 1000): Promise<void> {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("WebSocket did not close after missed pong.")),
      timeoutMs,
    );
    socket.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

describe("WebSocket heartbeat", () => {
  test.each([
    {
      slot: "global",
      maxActiveWsConnections: 1,
      maxActiveSessionsPerClient: 5,
    },
    {
      slot: "per-session",
      maxActiveWsConnections: 2,
      maxActiveSessionsPerClient: 1,
    },
  ])(
    "terminates a peer that misses pong and releases its $slot slot",
    async (limits) => {
      const stalledSshServer = createServer((socket) => sockets.add(socket));
      const sshPort = await listenPort(stalledSshServer);
      const auditEvents: Omit<AuditEvent, "ts">[] = [];
      const app = await createOmxtermServer(config, {
        audit: {
          write: (event) => {
            auditEvents.push(event);
          },
        },
        ...limits,
        websocketHeartbeatIntervalMs: 20,
      });
      try {
        const login = await app.inject({
          method: "POST",
          url: "/api/access",
          headers: { origin: config.allowedOrigins[0] },
          payload: { accessToken: config.accessToken },
        });
        const cookie = cookieHeader(login.headers["set-cookie"]);
        const firstTicket = await issueTicket(app, cookie, sshPort);
        const retryableTicket = await issueTicket(app, cookie, sshPort);
        await app.listen({ host: "127.0.0.1", port: 0 });
        const address = app.server.address();
        if (!address || typeof address === "string") {
          throw new Error("Expected an HTTP listen address.");
        }

        const first = await attemptUpgrade(address.port, firstTicket, cookie);
        expect(first.response).toMatch(/^HTTP\/1\.1 101 /);
        // Drain bytes at the TCP layer without implementing WebSocket control
        // frames, so server pings receive no pong and the peer remains stalled.
        first.socket.resume();

        const full = await attemptUpgrade(address.port, retryableTicket, cookie);
        expect(full.response).toMatch(/^HTTP\/1\.1 409 /);
        full.socket.destroy();

        await waitForClose(first.socket);
        expect(auditEvents).toContainEqual(
          expect.objectContaining({
            event: "session_ended",
            severity: "warn",
            reason: "websocket_heartbeat_timeout",
          }),
        );

        const reclaimed = await attemptUpgrade(
          address.port,
          retryableTicket,
          cookie,
        );
        expect(reclaimed.response).toMatch(/^HTTP\/1\.1 101 /);
        reclaimed.socket.destroy();
      } finally {
        const closedSockets = [...sockets].map(
          (socket) =>
            new Promise<void>((resolve) => {
              if (socket.destroyed) return resolve();
              socket.once("close", () => resolve());
              socket.destroy();
            }),
        );
        await Promise.all(closedSockets);
        sockets.clear();
        app.server.closeAllConnections();
        await app.close();
        stalledSshServer.close();
      }
    },
  );

  test("keeps a healthy client open while automatic pongs retain its slot", async () => {
    const stalledSshServer = createServer((socket) => sockets.add(socket));
    const sshPort = await listenPort(stalledSshServer);
    const app = await createOmxtermServer(config, {
      audit: discardAudit,
      maxActiveWsConnections: 1,
      websocketHeartbeatIntervalMs: 20,
    });
    let healthyClient: WebSocket | undefined;
    try {
      const login = await app.inject({
        method: "POST",
        url: "/api/access",
        headers: { origin: config.allowedOrigins[0] },
        payload: { accessToken: config.accessToken },
      });
      const cookie = cookieHeader(login.headers["set-cookie"]);
      const healthyTicket = await issueTicket(app, cookie, sshPort);
      const capacityProbeTicket = await issueTicket(app, cookie, sshPort);
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected an HTTP listen address.");
      }

      const healthyUrl =
        `ws://127.0.0.1:${address.port}/terminal/ws?ticket=` +
        encodeURIComponent(healthyTicket);
      healthyClient = new WebSocket(
        healthyUrl,
        { headers: { Cookie: cookie, Origin: config.allowedOrigins[0] } },
      );
      await new Promise<void>((resolve, reject) => {
        healthyClient?.once("open", () => resolve());
        healthyClient?.once("error", reject);
      });

      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(healthyClient.readyState).toBe(WebSocket.OPEN);

      const full = await attemptUpgrade(
        address.port,
        capacityProbeTicket,
        cookie,
      );
      expect(full.response).toMatch(/^HTTP\/1\.1 409 /);
      full.socket.destroy();
    } finally {
      healthyClient?.terminate();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      app.server.closeAllConnections();
      await app.close();
      stalledSshServer.close();
    }
  });
});
