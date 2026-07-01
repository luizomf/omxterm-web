import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
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
