import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createOmxtermServer, scrubSshConnectionSecrets } from "./server";
import type { ServerConfig } from "./config";

const baseConfig: ServerConfig = {
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

describe("scrubSshConnectionSecrets", () => {
  test("clears private key and passphrase without dropping connection metadata", () => {
    const profile = {
      host: "ssh.example",
      port: 22,
      username: "deploy",
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----secret",
      passphrase: "top-secret",
      acceptedHostFingerprint: "SHA256:test",
    };

    scrubSshConnectionSecrets(profile);

    expect(profile.privateKey).toBe("");
    expect(profile.passphrase).toBe("");
    expect(profile.host).toBe("ssh.example");
    expect(profile.port).toBe(22);
    expect(profile.username).toBe("deploy");
    expect(profile.acceptedHostFingerprint).toBe("SHA256:test");
  });
});

describe("POST /api/access", () => {
  test("rejects login attempts from an Origin outside the allowlist", async () => {
    const app = await createOmxtermServer(baseConfig);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/access",
        headers: { origin: "https://evil.example" },
        payload: { accessToken: baseConfig.accessToken },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ ok: false, message: "Bad Origin." });
      expect(response.headers["set-cookie"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  test("sets auth cookies for a valid token from an allowed Origin", async () => {
    const app = await createOmxtermServer(baseConfig);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/access",
        headers: { origin: "https://omxterm.example" },
        payload: { accessToken: baseConfig.accessToken },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
      expect(response.headers["set-cookie"]).toBeDefined();
    } finally {
      await app.close();
    }
  });
});

async function listenOnLoopback(
  app: Awaited<ReturnType<typeof createOmxtermServer>>,
): Promise<number> {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not read the test server port.");
  }
  return address.port;
}

async function sendRawHttpRequest(
  port: number,
  request: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let response = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(request));
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.on("end", () => resolve(response));
    socket.on("close", () => resolve(response));
    socket.on("error", reject);
  });
}

async function openRawWebSocket(
  port: number,
  path: string,
  cookie: string,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let response = "";
    socket.on("connect", () => {
      socket.write(rawWebSocketUpgradeRequest(path, cookie));
    });
    socket.on("data", function readHandshake(chunk) {
      response += chunk;
      if (!response.includes("\r\n\r\n")) return;
      socket.off("data", readHandshake);
      if (!response.startsWith("HTTP/1.1 101 ")) {
        reject(new Error(`WebSocket handshake failed: ${response}`));
        socket.destroy();
        return;
      }
      resolve(socket);
    });
    socket.on("error", reject);
  });
}

function rawWebSocketUpgradeRequest(path: string, cookie: string): string {
  return [
    `GET ${path} HTTP/1.1`,
    "Host: 127.0.0.1",
    "Connection: Upgrade",
    "Upgrade: websocket",
    "Sec-WebSocket-Version: 13",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    `Origin: ${baseConfig.allowedOrigins[0]}`,
    `Cookie: ${cookie}`,
    "",
    "",
  ].join("\r\n");
}

async function terminalTicket(
  app: Awaited<ReturnType<typeof createOmxtermServer>>,
  config: ServerConfig,
  cookie: string,
  port = 22,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/terminal-ticket",
    headers: { origin: config.allowedOrigins[0], cookie },
    payload: {
      host: "127.0.0.1",
      port,
      username: "test-user",
      privateKey: "test-private-key",
      passphrase: "test-passphrase",
      acceptedHostFingerprint: "SHA256:test",
    },
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ ticket: string }>().ticket;
}

function maskedInvalidUtf8Frame(): Buffer {
  const mask = Buffer.from([1, 2, 3, 4]);
  const invalidUtf8 = Buffer.from([0xc3, 0x28]);
  const maskedPayload = Buffer.from(
    invalidUtf8.map(
      (byte, index) => byte ^ mask.readUInt8(index % mask.length),
    ),
  );
  return Buffer.concat([Buffer.from([0x81, 0x82]), mask, maskedPayload]);
}

function maskedOversizedFrame(): Buffer {
  const payloadLength = Buffer.alloc(8);
  payloadLength.writeBigUInt64BE(65_537n);
  return Buffer.concat([
    Buffer.from([0x81, 0xff]),
    payloadLength,
    Buffer.from([1, 2, 3, 4]),
  ]);
}

describe("WebSocket upgrade boundary", () => {
  test("rejects a malformed request target without taking down the broker", async () => {
    const auditDir = mkdtempSync(join(tmpdir(), "omxterm-audit-"));
    const auditLogPath = join(auditDir, "audit.jsonl");
    const config: ServerConfig = { ...baseConfig, auditLogPath };
    const app = await createOmxtermServer(config);
    try {
      const port = await listenOnLoopback(app);
      const response = await sendRawHttpRequest(
        port,
        [
          "GET //example.com:99999/?ticket=secret-ticket HTTP/1.1",
          "Host: 127.0.0.1",
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          `Origin: ${baseConfig.allowedOrigins[0]}`,
          "Cookie: session=secret-cookie",
          "",
          "",
        ].join("\r\n"),
      );

      expect(response).toMatch(/^HTTP\/1\.1 400 /);
      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);

      const auditLog = readFileSync(auditLogPath, "utf8");
      expect(auditLog).toContain('"reason":"upgrade_error"');
      expect(auditLog).not.toContain("secret-ticket");
      expect(auditLog).not.toContain("secret-cookie");
    } finally {
      await app.close();
      rmSync(auditDir, { recursive: true, force: true });
    }
  });

  test.each([
    { frameName: "invalid UTF-8", frame: maskedInvalidUtf8Frame },
    { frameName: "oversized", frame: maskedOversizedFrame },
  ])(
    "contains an $frameName frame to its WebSocket connection",
    async ({ frame }) => {
      const auditDir = mkdtempSync(join(tmpdir(), "omxterm-audit-"));
      const auditLogPath = join(auditDir, "audit.jsonl");
      const config: ServerConfig = { ...baseConfig, auditLogPath };
      const app = await createOmxtermServer(config);
      let socket: Socket | undefined;
      try {
        const cookie = await loginCookieHeader(app, config);
        const ticket = await terminalTicket(app, config, cookie);
        const port = await listenOnLoopback(app);
        const path = `/terminal/ws?ticket=${encodeURIComponent(ticket)}`;
        socket = await openRawWebSocket(port, path, cookie);

        socket.write(frame());

        await new Promise<void>((resolve) =>
          socket?.once("close", () => resolve()),
        );
        const health = await app.inject({ method: "GET", url: "/health" });
        expect(health.statusCode).toBe(200);

        const replayResponse = await sendRawHttpRequest(
          port,
          rawWebSocketUpgradeRequest(path, cookie),
        );
        expect(replayResponse).toMatch(/^HTTP\/1\.1 403 /);

        const auditLog = readFileSync(auditLogPath, "utf8");
        expect(auditLog).toContain('"reason":"websocket_error"');
        expect(auditLog).not.toContain(ticket);
        expect(auditLog).not.toContain("test-private-key");
        expect(auditLog).not.toContain("test-passphrase");
      } finally {
        socket?.destroy();
        await app.close();
        rmSync(auditDir, { recursive: true, force: true });
      }
    },
  );
});

function cookieHeaderFromSetCookie(
  setCookie: number | string | string[] | undefined,
): string {
  const cookies = Array.isArray(setCookie)
    ? setCookie
    : typeof setCookie === "string"
      ? [setCookie]
      : [];
  expect(cookies).toHaveLength(3);
  return cookies.map((value) => value.split(";")[0]).join("; ");
}

describe("GET /api/me", () => {
  test("rejects requests from an Origin outside the allowlist", async () => {
    const app = await createOmxtermServer(baseConfig);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/me",
        headers: { origin: "https://evil.example" },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ ok: false, message: "Bad Origin." });
    } finally {
      await app.close();
    }
  });

  test("returns unauthenticated for allowed-Origin requests without cookies", async () => {
    const app = await createOmxtermServer(baseConfig);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/me",
        headers: { origin: "https://omxterm.example" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ authenticated: false });
    } finally {
      await app.close();
    }
  });

  test("allows same-origin browser auth checks without an Origin header", async () => {
    const app = await createOmxtermServer(baseConfig);
    try {
      const login = await app.inject({
        method: "POST",
        url: "/api/access",
        headers: { origin: "https://omxterm.example" },
        payload: { accessToken: baseConfig.accessToken },
      });
      expect(login.statusCode).toBe(200);

      const response = await app.inject({
        method: "GET",
        url: "/api/me",
        headers: {
          cookie: cookieHeaderFromSetCookie(login.headers["set-cookie"]),
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ authenticated: true });
    } finally {
      await app.close();
    }
  });
});

// Binds an ephemeral port and releases it immediately, so the caller gets a
// loopback port guaranteed to refuse the next connection attempt.
async function unusedTcpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port =
        address && typeof address === "object" ? address.port : undefined;
      probe.close(() => {
        if (port) resolve(port);
        else reject(new Error("Could not allocate a test port."));
      });
    });
  });
}

async function loginCookieHeader(
  app: Awaited<ReturnType<typeof createOmxtermServer>>,
  config: ServerConfig,
): Promise<string> {
  const login = await app.inject({
    method: "POST",
    url: "/api/access",
    headers: { origin: config.allowedOrigins[0] },
    payload: { accessToken: config.accessToken },
  });
  expect(login.statusCode).toBe(200);
  return cookieHeaderFromSetCookie(login.headers["set-cookie"]);
}

async function waitForAuditEvent(
  auditLogPath: string,
  event: string,
  timeoutMs = 8000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let lastContents = "";
  while (Date.now() < deadline) {
    try {
      lastContents = readFileSync(auditLogPath, "utf8");
      const found = lastContents
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((entry) => entry.event === event);
      if (found) return found;
    } catch {
      // The log file may not exist yet on the first poll.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Audit event "${event}" not found within ${timeoutMs}ms. Log:\n${lastContents}`,
  );
}

describe("terminal session SSH dial failure", () => {
  test("audits a normalized connect-failure reason without leaking credentials", async () => {
    const auditDir = mkdtempSync(join(tmpdir(), "omxterm-audit-"));
    const auditLogPath = join(auditDir, "audit.jsonl");
    const config: ServerConfig = { ...baseConfig, auditLogPath };
    const app = await createOmxtermServer(config);
    let socket: Socket | undefined;
    try {
      const cookie = await loginCookieHeader(app, config);
      const refusedPort = await unusedTcpPort();
      const ticket = await terminalTicket(app, config, cookie, refusedPort);
      const port = await listenOnLoopback(app);
      const path = `/terminal/ws?ticket=${encodeURIComponent(ticket)}`;
      socket = await openRawWebSocket(port, path, cookie);

      // The broker dials a refused port, so connect() rejects promptly and the
      // server audits the normalized reason. Poll the log until it lands.
      const failure = await waitForAuditEvent(
        auditLogPath,
        "session_connect_failed",
      );
      expect(failure).toMatchObject({ severity: "warn", host: "127.0.0.1" });
      expect(failure.reason).toEqual(expect.any(String));
      expect(failure.reason).not.toBe("");

      const auditLog = readFileSync(auditLogPath, "utf8");
      expect(auditLog).not.toContain("test-private-key");
      expect(auditLog).not.toContain("test-passphrase");
      expect(auditLog).not.toContain(ticket);
    } finally {
      socket?.destroy();
      await app.close();
      rmSync(auditDir, { recursive: true, force: true });
    }
  });
});

describe("POST /api/ssh/host-key", () => {
  test("audits the real failure reason instead of discarding it when the probe fails", async () => {
    const auditDir = mkdtempSync(join(tmpdir(), "omxterm-audit-"));
    const auditLogPath = join(auditDir, "audit.jsonl");
    const config: ServerConfig = { ...baseConfig, auditLogPath };
    const app = await createOmxtermServer(config);
    try {
      const cookie = await loginCookieHeader(app, config);
      const refusedPort = await unusedTcpPort();

      const response = await app.inject({
        method: "POST",
        url: "/api/ssh/host-key",
        headers: { origin: config.allowedOrigins[0], cookie },
        payload: { host: "127.0.0.1", port: refusedPort },
      });

      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual({
        ok: false,
        message: "Could not read SSH host key.",
      });

      const auditLines = readFileSync(auditLogPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const failureEvent = auditLines.find(
        (entry) => entry.event === "host_key_probe_failed",
      );
      expect(failureEvent).toMatchObject({
        severity: "warn",
        host: "127.0.0.1",
        port: refusedPort,
      });
      expect(typeof failureEvent.reason).toBe("string");
      expect(failureEvent.reason.length).toBeGreaterThan(0);
    } finally {
      await app.close();
      rmSync(auditDir, { recursive: true, force: true });
    }
  });
});
