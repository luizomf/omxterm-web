import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  ACCESS_GATE_MAX_FAILURES,
  ACCESS_GATE_WINDOW_MS,
  ACCESS_REQUEST_BODY_LIMIT_BYTES,
  createOmxtermServer,
  HOST_KEY_REQUEST_BODY_LIMIT_BYTES,
  MAX_AUTHENTICATED_WS_REJECTION_AUDITS_PER_REASON_PER_WINDOW,
  MAX_AUTHENTICATED_WS_UPGRADE_ATTEMPTS_PER_WINDOW,
  MAX_UNAUTHENTICATED_REJECTION_AUDITS_PER_REASON_PER_WINDOW,
  TERMINAL_TICKET_REQUEST_BODY_LIMIT_BYTES,
} from "./server";
import { JsonlAuditLogger } from "./audit-logger";
import type { AuditEvent, AuditLogger } from "@omxterm/core/audit";
import { MAX_PRIVATE_KEY_BYTES } from "@omxterm/core/ssh";
import { resolveWebRoot, type ServerConfig } from "./config";

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

const SYNTHETIC_SPA_INDEX = "<main>synthetic SPA shell</main>";
const SYNTHETIC_PUBLIC_ASSET = "window.syntheticAsset = true;";

function createSyntheticWebRoot(): string {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "omxterm-static-root-"));
  const assetsRoot = join(fixtureRoot, "assets");
  mkdirSync(assetsRoot);
  writeFileSync(join(fixtureRoot, "index.html"), SYNTHETIC_SPA_INDEX);
  writeFileSync(join(assetsRoot, "app.js"), SYNTHETIC_PUBLIC_ASSET);
  return fixtureRoot;
}

describe("SPA static serving", () => {
  let fixtureRoot: string;
  let app: Awaited<ReturnType<typeof createOmxtermServer>> | undefined;

  beforeEach(() => {
    fixtureRoot = createSyntheticWebRoot();
    app = undefined;
  });

  afterEach(async () => {
    try {
      await app?.close();
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  async function startSpaServer() {
    const webRoot = resolveWebRoot(fixtureRoot);
    if (!webRoot) throw new Error("Expected the synthetic web root to resolve.");
    app = await createOmxtermServer({ ...baseConfig, webRoot });
    return app;
  }

  test("serves the index, public assets, and client-route fallback from a valid root", async () => {
    const app = await startSpaServer();
    const index = await app.inject({ method: "GET", url: "/" });
    const asset = await app.inject({ method: "GET", url: "/assets/app.js" });
    const clientRoute = await app.inject({
      method: "GET",
      url: "/connect/confirm",
    });

    expect(index.statusCode).toBe(200);
    expect(index.body).toBe(SYNTHETIC_SPA_INDEX);
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toBe(SYNTHETIC_PUBLIC_ASSET);
    expect(clientRoute.statusCode).toBe(200);
    expect(clientRoute.body).toBe(SYNTHETIC_SPA_INDEX);
  });

  test("keeps raw-fragment protected paths out of the SPA fallback", async () => {
    const app = await startSpaServer();
    const port = await listenOnLoopback(app);
    const rawGet = (path: string) =>
      [
        `GET ${path} HTTP/1.1`,
        "Host: 127.0.0.1",
        "Connection: close",
        "",
        "",
      ].join("\r\n");

    for (const protectedPath of [
      "/api#missing",
      "/health/details#missing",
      "/terminal#missing",
    ]) {
      const response = await sendRawHttpRequest(port, rawGet(protectedPath));

      expect(response).toMatch(/^HTTP\/1\.1 404 /);
      expect(response).not.toContain(SYNTHETIC_SPA_INDEX);
    }

    for (const clientPath of ["/connect#confirm", "/api%23missing"]) {
      const clientFallback = await sendRawHttpRequest(
        port,
        rawGet(clientPath),
      );

      expect(clientFallback).toMatch(/^HTTP\/1\.1 200 /);
      expect(clientFallback).toContain(SYNTHETIC_SPA_INDEX);
    }
  });

  test("keeps API routes authoritative instead of using static files or the SPA fallback", async () => {
    const apiShadowBody = "synthetic static API shadow";
    mkdirSync(join(fixtureRoot, "api"));
    writeFileSync(join(fixtureRoot, "api", "client-route"), apiShadowBody);
    const app = await startSpaServer();
    const knownApiRoute = await app.inject({ method: "GET", url: "/api/me" });
    const unknownApiRoute = await app.inject({
      method: "GET",
      url: "/api/client-route",
    });

    expect(knownApiRoute.statusCode).toBe(200);
    expect(knownApiRoute.json()).toEqual({ authenticated: false });
    expect(unknownApiRoute.statusCode).toBe(404);
    expect(unknownApiRoute.body).not.toContain(apiShadowBody);
    expect(unknownApiRoute.body).not.toContain(SYNTHETIC_SPA_INDEX);
  });

  test("denies encoded-separator static shadows for server-owned and hidden paths", async () => {
    const staticShadows = [
      {
        requestPath: "/api%2fclient-route",
        fileName: "api%2fclient-route",
        body: "synthetic encoded API shadow",
      },
      {
        requestPath: "/health%2fdetails",
        fileName: "health%2fdetails",
        body: "synthetic encoded health shadow",
      },
      {
        requestPath: "/terminal%2fws",
        fileName: "terminal%2fws",
        body: "synthetic encoded terminal shadow",
      },
      {
        requestPath: "/%2fapi%2fdouble-leading",
        fileName: "%2fapi%2fdouble-leading",
        body: "synthetic encoded leading-slash shadow",
      },
      {
        requestPath: "/assets%2f.synthetic-private%2fpublic.txt",
        fileName: "assets%2f.synthetic-private%2fpublic.txt",
        body: "synthetic encoded hidden shadow",
      },
    ];
    for (const shadow of staticShadows) {
      writeFileSync(join(fixtureRoot, shadow.fileName), shadow.body);
    }
    const app = await startSpaServer();

    for (const shadow of staticShadows) {
      const response = await app.inject({
        method: "GET",
        url: shadow.requestPath,
      });

      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain(shadow.body);
      expect(response.body).not.toContain(SYNTHETIC_SPA_INDEX);
    }
  });

  test("does not SPA-fallback after malformed static-policy encoding", async () => {
    const malformedBody = "synthetic malformed static shadow";
    writeFileSync(join(fixtureRoot, "synthetic-malformed%"), malformedBody);
    const app = await startSpaServer();
    const response = await app.inject({
      method: "GET",
      url: "/synthetic-malformed%25",
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain(malformedBody);
    expect(response.body).not.toContain(SYNTHETIC_SPA_INDEX);
  });

  test("keeps terminal security routing out of the SPA fallback", async () => {
    const app = await startSpaServer();
    const terminalRoute = await app.inject({
      method: "GET",
      url: "/terminal/ws",
    });
    const health = await app.inject({ method: "GET", url: "/health" });
    const unknownHealthRoute = await app.inject({
      method: "GET",
      url: "/health/details",
    });

    expect(terminalRoute.statusCode).toBe(404);
    expect(terminalRoute.body).not.toContain(SYNTHETIC_SPA_INDEX);
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ ok: true });
    expect(unknownHealthRoute.statusCode).toBe(404);
    expect(unknownHealthRoute.body).not.toContain(SYNTHETIC_SPA_INDEX);
  });

  test("denies a dotfile without returning hidden content or the SPA index", async () => {
    const hiddenBody = "synthetic hidden deployment file";
    writeFileSync(join(fixtureRoot, ".synthetic-config"), hiddenBody);
    const app = await startSpaServer();

    for (const hiddenPath of [
      "/.synthetic-config",
      "/%2esynthetic-config",
    ]) {
      const response = await app.inject({
        method: "GET",
        url: hiddenPath,
      });

      expect([403, 404]).toContain(response.statusCode);
      expect(response.body).not.toContain(hiddenBody);
      expect(response.body).not.toContain(SYNTHETIC_SPA_INDEX);
    }
  });

  test("denies content below a hidden directory without falling back to the SPA", async () => {
    const hiddenDirectory = join(fixtureRoot, "assets", ".synthetic-private");
    const hiddenBody = "synthetic hidden nested content";
    mkdirSync(hiddenDirectory);
    writeFileSync(join(hiddenDirectory, "public.txt"), hiddenBody);
    const app = await startSpaServer();
    const response = await app.inject({
      method: "GET",
      url: "/assets/.synthetic-private/public.txt",
    });

    expect([403, 404]).toContain(response.statusCode);
    expect(response.body).not.toContain(hiddenBody);
    expect(response.body).not.toContain(SYNTHETIC_SPA_INDEX);
  });
});

describe("request body limits", () => {
  test.each([
    {
      url: "/api/access",
      limit: ACCESS_REQUEST_BODY_LIMIT_BYTES,
      field: "accessToken",
    },
    {
      url: "/api/ssh/host-key",
      limit: HOST_KEY_REQUEST_BODY_LIMIT_BYTES,
      field: "host",
    },
    {
      url: "/api/terminal-ticket",
      limit: TERMINAL_TICKET_REQUEST_BODY_LIMIT_BYTES,
      field: "privateKey",
    },
  ])(
    "rejects $url before parsing a body beyond its input envelope",
    async ({ url, limit, field }) => {
      const app = await createOmxtermServer(baseConfig);
      try {
        const response = await app.inject({
          method: "POST",
          url,
          headers: {
            origin: baseConfig.allowedOrigins[0],
            "content-type": "application/json",
          },
          payload: JSON.stringify({ [field]: "x".repeat(limit) }),
        });

        expect(response.statusCode).toBe(413);
      } finally {
        await app.close();
      }
    },
  );

  test("parses worst-case JSON escaping for every schema-valid string envelope", async () => {
    const escapedCodeUnit = "\\u0000";
    const requests = [
      {
        url: "/api/access",
        limit: ACCESS_REQUEST_BODY_LIMIT_BYTES,
        body: `{"accessToken":"${escapedCodeUnit.repeat(4096)}"}`,
      },
      {
        url: "/api/ssh/host-key",
        limit: HOST_KEY_REQUEST_BODY_LIMIT_BYTES,
        body: `{"host":"${escapedCodeUnit.repeat(255)}","port":65535}`,
      },
      {
        url: "/api/terminal-ticket",
        limit: TERMINAL_TICKET_REQUEST_BODY_LIMIT_BYTES,
        body: `{"host":"${escapedCodeUnit.repeat(255)}","port":65535,"username":"${escapedCodeUnit.repeat(128)}","privateKey":"${escapedCodeUnit.repeat(MAX_PRIVATE_KEY_BYTES)}","passphrase":"${escapedCodeUnit.repeat(4096)}","acceptedHostFingerprint":"${escapedCodeUnit.repeat(256)}"}`,
      },
    ];
    const app = await createOmxtermServer(baseConfig);

    try {
      for (const request of requests) {
        expect(Buffer.byteLength(request.body)).toBeLessThanOrEqual(
          request.limit,
        );
        const response = await app.inject({
          method: "POST",
          url: request.url,
          headers: {
            origin: baseConfig.allowedOrigins[0],
            "content-type": "application/json",
          },
          payload: request.body,
        });
        expect(response.statusCode).not.toBe(413);
      }
    } finally {
      await app.close();
    }
  });

  test("rejects a private key whose UTF-8 representation exceeds 64 KiB", async () => {
    const app = await createOmxtermServer(baseConfig);
    try {
      const cookie = await loginCookieHeader(app, baseConfig);
      const response = await app.inject({
        method: "POST",
        url: "/api/terminal-ticket",
        headers: { origin: baseConfig.allowedOrigins[0], cookie },
        payload: {
          host: "127.0.0.1",
          port: 22,
          username: "test-user",
          privateKey: "é".repeat(MAX_PRIVATE_KEY_BYTES / 2 + 1),
          acceptedHostFingerprint: "SHA256:test",
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        ok: false,
        message: "Invalid SSH connection profile.",
      });
    } finally {
      await app.close();
    }
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

type ClientLocation = { remoteAddress?: string; forwardedFor?: string };

function accessAttempt(
  app: Awaited<ReturnType<typeof createOmxtermServer>>,
  config: ServerConfig,
  accessToken: string,
  client: ClientLocation = {},
) {
  const headers: Record<string, string | undefined> = {
    origin: config.allowedOrigins[0],
  };
  if (client.forwardedFor !== undefined) {
    headers["x-forwarded-for"] = client.forwardedFor;
  }
  return app.inject({
    method: "POST",
    url: "/api/access",
    headers,
    ...(client.remoteAddress !== undefined
      ? { remoteAddress: client.remoteAddress }
      : {}),
    payload: { accessToken },
  });
}

async function exhaustAccessFailureBudget(
  app: Awaited<ReturnType<typeof createOmxtermServer>>,
  config: ServerConfig,
  client: ClientLocation = {},
): Promise<void> {
  for (let attempt = 0; attempt < ACCESS_GATE_MAX_FAILURES; attempt++) {
    const response = await accessAttempt(app, config, "wrong-token", client);
    expect(response.statusCode).toBe(401);
  }
}

describe("POST /api/access abuse policy", () => {
  test("bounds durable bad-Origin audit growth without weakening Origin or invalid-token rejection", async () => {
    const auditDir = mkdtempSync(join(tmpdir(), "omxterm-origin-audit-"));
    const auditLogPath = join(auditDir, "audit.jsonl");
    const config: ServerConfig = { ...baseConfig, auditLogPath };
    const app = await createOmxtermServer(config);
    const client = { remoteAddress: "203.0.113.60" };
    const attackerOrigin = "https://attacker-controlled.example/unique";

    try {
      for (
        let attempt = 0;
        attempt <
        MAX_UNAUTHENTICATED_REJECTION_AUDITS_PER_REASON_PER_WINDOW + 5;
        attempt++
      ) {
        const response = await app.inject({
          method: "POST",
          url: "/api/access",
          headers: attempt % 2 === 0 ? { origin: attackerOrigin } : {},
          remoteAddress: client.remoteAddress,
          payload: { accessToken: config.accessToken },
        });

        expect(response.statusCode).toBe(403);
        expect(response.headers["set-cookie"]).toBeUndefined();
      }

      const originRejections = readFileSync(auditLogPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(originRejections).toHaveLength(
        MAX_UNAUTHENTICATED_REJECTION_AUDITS_PER_REASON_PER_WINDOW,
      );
      expect(
        originRejections.every(
          (event) =>
            event.event === "access_rejected" &&
            event.reason === "bad_origin" &&
            event.origin === undefined,
        ),
      ).toBe(true);
      expect(JSON.stringify(originRejections)).not.toContain(attackerOrigin);

      await exhaustAccessFailureBudget(app, config, client);
      for (let attempt = 0; attempt < 40; attempt++) {
        const blocked = await accessAttempt(app, config, "wrong-token", {
          ...client,
          forwardedFor: `198.51.100.${attempt}`,
        });

        expect(blocked.statusCode).toBe(429);
        const retryAfter = Number(blocked.headers["retry-after"]);
        expect(retryAfter).toBeGreaterThan(0);
        expect(retryAfter).toBeLessThanOrEqual(
          Math.ceil(ACCESS_GATE_WINDOW_MS / 1000),
        );
      }

      const allEvents = readFileSync(auditLogPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(
        allEvents.filter((event) => event.reason === "bad_origin"),
      ).toHaveLength(
        MAX_UNAUTHENTICATED_REJECTION_AUDITS_PER_REASON_PER_WINDOW,
      );
      expect(
        allEvents.filter((event) => event.reason === "invalid_access_token"),
      ).toHaveLength(ACCESS_GATE_MAX_FAILURES);
      const rateLimitedEvents = allEvents.filter(
        (event) => event.reason === "rate_limited",
      );
      expect(rateLimitedEvents).toHaveLength(
        MAX_UNAUTHENTICATED_REJECTION_AUDITS_PER_REASON_PER_WINDOW,
      );
      expect(
        rateLimitedEvents.every((event) => event.origin === undefined),
      ).toBe(true);
    } finally {
      await app.close();
      rmSync(auditDir, { recursive: true, force: true });
    }
  });

  test("equivalent unauthenticated HTTP endpoints reject bad or missing Origin without parallel audit amplification", async () => {
    const events: Omit<AuditEvent, "ts">[] = [];
    const audit: AuditLogger = {
      write: (event) => {
        events.push(event);
      },
    };
    const app = await createOmxtermServer(baseConfig, { audit });
    const rejectedRequests = [
      { method: "GET" as const, url: "/api/me", missingOrigin: false },
      {
        method: "POST" as const,
        url: "/api/ssh/host-key",
        missingOrigin: false,
      },
      {
        method: "POST" as const,
        url: "/api/ssh/host-key",
        missingOrigin: true,
      },
      {
        method: "POST" as const,
        url: "/api/terminal-ticket",
        missingOrigin: false,
      },
      {
        method: "POST" as const,
        url: "/api/terminal-ticket",
        missingOrigin: true,
      },
    ];

    try {
      for (const request of rejectedRequests) {
        const response = await app.inject({
          method: request.method,
          url: request.url,
          headers: request.missingOrigin
            ? {}
            : { origin: "https://evil.example" },
          remoteAddress: "203.0.113.61",
          ...(request.method === "POST" ? { payload: {} } : {}),
        });

        expect(response.statusCode).toBe(403);
        expect(response.headers["set-cookie"]).toBeUndefined();
      }
      expect(events).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  test("blocks a client with 429 and a valid Retry-After once its failed-attempt budget is exhausted", async () => {
    const app = await createOmxtermServer(baseConfig);
    try {
      const client = { remoteAddress: "203.0.113.10" };
      await exhaustAccessFailureBudget(app, baseConfig, client);

      const blocked = await accessAttempt(
        app,
        baseConfig,
        "wrong-token",
        client,
      );

      expect(blocked.statusCode).toBe(429);
      const retryAfter = Number(blocked.headers["retry-after"]);
      expect(Number.isInteger(retryAfter)).toBe(true);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(
        Math.ceil(ACCESS_GATE_WINDOW_MS / 1000),
      );
    } finally {
      await app.close();
    }
  });

  test("tracks a second client's failure budget independently of a blocked client", async () => {
    const app = await createOmxtermServer(baseConfig);
    try {
      const blockedClient = { remoteAddress: "203.0.113.10" };
      const otherClient = { remoteAddress: "203.0.113.20" };
      await exhaustAccessFailureBudget(app, baseConfig, blockedClient);
      const stillBlocked = await accessAttempt(
        app,
        baseConfig,
        "wrong-token",
        blockedClient,
      );
      expect(stillBlocked.statusCode).toBe(429);

      const otherAttempt = await accessAttempt(
        app,
        baseConfig,
        "wrong-token",
        otherClient,
      );

      expect(otherAttempt.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  test("a successful login resets the client's failed-attempt window to a full budget", async () => {
    const app = await createOmxtermServer(baseConfig);
    try {
      const client = { remoteAddress: "203.0.113.30" };
      // One short of the block, then succeed — the reset must restore the FULL
      // budget, not merely avoid tripping the limiter on this one occasion.
      for (let attempt = 0; attempt < ACCESS_GATE_MAX_FAILURES - 1; attempt++) {
        const response = await accessAttempt(
          app,
          baseConfig,
          "wrong-token",
          client,
        );
        expect(response.statusCode).toBe(401);
      }
      const login = await accessAttempt(
        app,
        baseConfig,
        baseConfig.accessToken,
        client,
      );
      expect(login.statusCode).toBe(200);

      await exhaustAccessFailureBudget(app, baseConfig, client);
      const blocked = await accessAttempt(
        app,
        baseConfig,
        "wrong-token",
        client,
      );

      expect(blocked.statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });

  test("a direct-server deployment keys on the real socket peer and ignores a spoofed X-Forwarded-For", async () => {
    const config: ServerConfig = { ...baseConfig, trustProxy: false };
    const app = await createOmxtermServer(config);
    try {
      const peerAddress = "203.0.113.40";
      for (let attempt = 0; attempt < ACCESS_GATE_MAX_FAILURES; attempt++) {
        const response = await accessAttempt(app, config, "wrong-token", {
          remoteAddress: peerAddress,
          forwardedFor: `198.51.100.${attempt}`,
        });
        expect(response.statusCode).toBe(401);
      }

      const blocked = await accessAttempt(app, config, "wrong-token", {
        remoteAddress: peerAddress,
        forwardedFor: "198.51.100.250",
      });

      expect(blocked.statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });

  test("a trusted-proxy deployment keys on the forwarded client, giving each real client its own budget", async () => {
    const trustedProxyAddress = "10.0.0.1";
    const config: ServerConfig = {
      ...baseConfig,
      trustProxy: trustedProxyAddress,
    };
    const app = await createOmxtermServer(config);
    try {
      const throughProxy = (forwardedFor: string): ClientLocation => ({
        remoteAddress: trustedProxyAddress,
        forwardedFor,
      });
      await exhaustAccessFailureBudget(
        app,
        config,
        throughProxy("198.51.100.5"),
      );
      const blocked = await accessAttempt(
        app,
        config,
        "wrong-token",
        throughProxy("198.51.100.5"),
      );
      expect(blocked.statusCode).toBe(429);

      const otherRealClient = await accessAttempt(
        app,
        config,
        "wrong-token",
        throughProxy("198.51.100.9"),
      );

      expect(otherRealClient.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  test("audits an invalid access attempt with metadata only, never the attempted token", async () => {
    const events: Omit<AuditEvent, "ts">[] = [];
    const audit: AuditLogger = {
      write: (event) => {
        events.push(event);
      },
    };
    const secretToken = "definitely-the-wrong-secret-token-value";
    const app = await createOmxtermServer(baseConfig, { audit });
    try {
      const response = await accessAttempt(app, baseConfig, secretToken, {
        remoteAddress: "203.0.113.50",
      });
      expect(response.statusCode).toBe(401);

      expect(events).toHaveLength(1);
      const [rejection] = events;
      if (!rejection)
        throw new Error("Expected one audit event to be recorded.");
      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain(secretToken);
      expect(serialized.toLowerCase()).not.toContain("cookie");
      expect(serialized.toLowerCase()).not.toContain("authorization");
      expect(Object.keys(rejection).sort()).toEqual(
        ["event", "origin", "reason", "severity"].sort(),
      );
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
  test("bounds authenticated invalid-ticket work and rejection audits", async () => {
    const events: Omit<AuditEvent, "ts">[] = [];
    const audit: AuditLogger = {
      write: (event) => {
        events.push(event);
      },
    };
    const app = await createOmxtermServer(baseConfig, { audit });

    try {
      const cookie = await loginCookieHeader(app, baseConfig);
      const port = await listenOnLoopback(app);
      const extraAttempts = 20;
      const responses: string[] = [];
      for (
        let attempt = 0;
        attempt <
        MAX_AUTHENTICATED_WS_UPGRADE_ATTEMPTS_PER_WINDOW + extraAttempts;
        attempt++
      ) {
        responses.push(
          await sendRawHttpRequest(
            port,
            rawWebSocketUpgradeRequest(
              `/terminal/ws?ticket=fake-ticket-${attempt}`,
              cookie,
            ),
          ),
        );
      }

      expect(
        responses
          .slice(0, MAX_AUTHENTICATED_WS_UPGRADE_ATTEMPTS_PER_WINDOW)
          .every((response) => /^HTTP\/1\.1 403 /.test(response)),
      ).toBe(true);
      expect(
        responses
          .slice(MAX_AUTHENTICATED_WS_UPGRADE_ATTEMPTS_PER_WINDOW)
          .every((response) => /^HTTP\/1\.1 429 /.test(response)),
      ).toBe(true);

      // Fresh access sessions must not reset either the direct peer's upgrade
      // budget or its bounded audit-write budget.
      for (let rotation = 0; rotation < 15; rotation++) {
        const rotatedCookie = await loginCookieHeader(app, baseConfig);
        const response = await sendRawHttpRequest(
          port,
          rawWebSocketUpgradeRequest(
            `/terminal/ws?ticket=rotated-fake-ticket-${rotation}`,
            rotatedCookie,
          ),
        );
        expect(response).toMatch(/^HTTP\/1\.1 429 /);
      }

      const upgradeRejections = events.filter(
        (event) => event.event === "ws_upgrade_rejected",
      );
      expect(
        upgradeRejections.filter(
          (event) => event.reason === "not_found_expired_or_used",
        ),
      ).toHaveLength(
        MAX_AUTHENTICATED_WS_REJECTION_AUDITS_PER_REASON_PER_WINDOW,
      );
      expect(
        upgradeRejections.filter((event) => event.reason === "rate_limited"),
      ).toHaveLength(
        MAX_AUTHENTICATED_WS_REJECTION_AUDITS_PER_REASON_PER_WINDOW,
      );
      expect(JSON.stringify(upgradeRejections)).not.toContain("fake-ticket");
    } finally {
      await app.close();
    }
  });

  test("closes upgraded sockets and their pending SSH session before app.close resolves", async () => {
    const stalledTarget = createServer();
    await new Promise<void>((resolve, reject) => {
      stalledTarget.once("error", reject);
      stalledTarget.listen(0, "127.0.0.1", () => resolve());
    });
    const targetAddress = stalledTarget.address();
    if (!targetAddress || typeof targetAddress === "string") {
      throw new Error("Expected a TCP target address.");
    }

    const app = await createOmxtermServer(baseConfig, {
      audit: { write() {} },
    });
    let socket: Socket | undefined;
    try {
      const cookie = await loginCookieHeader(app, baseConfig);
      const ticket = await terminalTicket(
        app,
        baseConfig,
        cookie,
        targetAddress.port,
      );
      const port = await listenOnLoopback(app);
      socket = await openRawWebSocket(
        port,
        `/terminal/ws?ticket=${encodeURIComponent(ticket)}`,
        cookie,
      );
      const socketClosed = new Promise<void>((resolve) =>
        socket?.once("close", () => resolve()),
      );

      await app.close();
      await socketClosed;

      expect(socket.destroyed).toBe(true);
    } finally {
      socket?.destroy();
      await app.close();
      await new Promise<void>((resolve) =>
        stalledTarget.close(() => resolve()),
      );
    }
  });

  test("shares the bad-Origin audit bound across access and WebSocket upgrade while both remain fail-closed", async () => {
    const events: Omit<AuditEvent, "ts">[] = [];
    const audit: AuditLogger = {
      write: (event) => {
        events.push(event);
      },
    };
    const app = await createOmxtermServer(baseConfig, { audit });
    const rejectedOrigin = "https://unique-attacker-origin.example";

    try {
      const port = await listenOnLoopback(app);
      for (let attempt = 0; attempt < 5; attempt++) {
        const response = await sendRawHttpRequest(
          port,
          [
            "POST /api/access HTTP/1.1",
            "Host: 127.0.0.1",
            "Connection: close",
            "Content-Type: application/json",
            "Content-Length: 2",
            `Origin: ${rejectedOrigin}`,
            "",
            "{}",
          ].join("\r\n"),
        );
        expect(response).toMatch(/^HTTP\/1\.1 403 /);
      }

      for (
        let attempt = 0;
        attempt <
        MAX_UNAUTHENTICATED_REJECTION_AUDITS_PER_REASON_PER_WINDOW + 5;
        attempt++
      ) {
        const originHeader =
          attempt % 2 === 0 ? [`Origin: ${rejectedOrigin}`] : [];
        const response = await sendRawHttpRequest(
          port,
          [
            "GET /terminal/ws HTTP/1.1",
            "Host: 127.0.0.1",
            "Connection: Upgrade",
            "Upgrade: websocket",
            "Sec-WebSocket-Version: 13",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
            ...originHeader,
            "",
            "",
          ].join("\r\n"),
        );
        expect(response).toMatch(/^HTTP\/1\.1 403 /);
      }

      expect(events).toHaveLength(
        MAX_UNAUTHENTICATED_REJECTION_AUDITS_PER_REASON_PER_WINDOW,
      );
      expect(
        events.every(
          (event) =>
            (event.event === "access_rejected" ||
              event.event === "ws_upgrade_rejected") &&
            event.reason === "bad_origin" &&
            event.origin === undefined,
        ),
      ).toBe(true);
      expect(JSON.stringify(events)).not.toContain(rejectedOrigin);
    } finally {
      await app.close();
    }
  });

  test("bounds missing-auth upgrade audits while every request stays unauthorized", async () => {
    const events: Omit<AuditEvent, "ts">[] = [];
    const audit: AuditLogger = {
      write: (event) => {
        events.push(event);
      },
    };
    const app = await createOmxtermServer(baseConfig, { audit });

    try {
      const port = await listenOnLoopback(app);
      for (let attempt = 0; attempt < 40; attempt++) {
        const attackerTicket = `attacker-ticket-${attempt}`;
        const attackerCookie = `attacker-cookie-${attempt}`;
        const response = await sendRawHttpRequest(
          port,
          [
            `GET /terminal/ws?ticket=${attackerTicket} HTTP/1.1`,
            "Host: 127.0.0.1",
            "Connection: Upgrade",
            "Upgrade: websocket",
            "Sec-WebSocket-Version: 13",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
            `Origin: ${baseConfig.allowedOrigins[0]}`,
            `Cookie: attacker=${attackerCookie}`,
            `X-Forwarded-For: 198.51.100.${attempt}`,
            "",
            "",
          ].join("\r\n"),
        );

        expect(response).toMatch(/^HTTP\/1\.1 401 /);
      }

      expect(
        events.filter((event) => event.reason === "missing_auth_or_ticket"),
      ).toHaveLength(
        MAX_UNAUTHENTICATED_REJECTION_AUDITS_PER_REASON_PER_WINDOW,
      );
      expect(JSON.stringify(events)).not.toContain("attacker-ticket");
      expect(JSON.stringify(events)).not.toContain("attacker-cookie");
      expect(JSON.stringify(events)).not.toContain("198.51.100");
      expect(JSON.stringify(events)).not.toContain(
        baseConfig.allowedOrigins[0],
      );
    } finally {
      await app.close();
    }
  });

  test("bounds malformed-target upgrade audits while every request stays rejected", async () => {
    const auditDir = mkdtempSync(join(tmpdir(), "omxterm-audit-"));
    const auditLogPath = join(auditDir, "audit.jsonl");
    const config: ServerConfig = { ...baseConfig, auditLogPath };
    const app = await createOmxtermServer(config);
    try {
      const port = await listenOnLoopback(app);
      const responses = await Promise.all(
        Array.from({ length: 50 }, (_, attempt) =>
          sendRawHttpRequest(
            port,
            [
              `GET //attacker-${attempt}.example:99999/?ticket=secret-ticket-${attempt} HTTP/1.1`,
              "Host: 127.0.0.1",
              "Connection: Upgrade",
              "Upgrade: websocket",
              "Sec-WebSocket-Version: 13",
              "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
              `Origin: ${baseConfig.allowedOrigins[0]}`,
              `Cookie: session=secret-cookie-${attempt}`,
              `X-Forwarded-For: 198.51.100.${attempt}`,
              "",
              "",
            ].join("\r\n"),
          ),
        ),
      );

      expect(responses).toHaveLength(50);
      expect(
        responses.every((response) => /^HTTP\/1\.1 400 /.test(response)),
      ).toBe(true);
      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);

      const upgradeErrors = readFileSync(auditLogPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(upgradeErrors).toHaveLength(
        MAX_UNAUTHENTICATED_REJECTION_AUDITS_PER_REASON_PER_WINDOW,
      );
      expect(
        upgradeErrors.every(
          (event) =>
            event.event === "ws_upgrade_rejected" &&
            event.reason === "upgrade_error",
        ),
      ).toBe(true);
      for (const event of upgradeErrors) {
        expect(Object.keys(event).sort()).toEqual([
          "event",
          "reason",
          "severity",
          "ts",
        ]);
      }
      const serializedEvents = JSON.stringify(upgradeErrors);
      expect(serializedEvents).not.toContain("attacker-");
      expect(serializedEvents).not.toContain("secret-ticket");
      expect(serializedEvents).not.toContain("secret-cookie");
      expect(serializedEvents).not.toContain("198.51.100");
      expect(serializedEvents).not.toContain(baseConfig.allowedOrigins[0]);
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

describe("audit sink failure isolation", () => {
  test("fails fast at startup when the configured audit sink is not writable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omxterm-audit-"));
    // A regular file where a directory is expected makes the sink unwritable.
    const occupied = join(dir, "occupied");
    writeFileSync(occupied, "x");
    const auditLogPath = join(occupied, "audit.jsonl");
    try {
      await expect(
        createOmxtermServer({ ...baseConfig, auditLogPath }),
      ).rejects.toThrow(/OMXTERM_AUDIT_LOG/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps the broker alive when a runtime sink failure hits the raw upgrade boundary", async () => {
    // The real logger over a sink that always throws models a disk that filled
    // after boot; the failure must not escape the raw "upgrade" listener (#79).
    const audit = new JsonlAuditLogger(
      () => {
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      },
      () => {},
    );
    const app = await createOmxtermServer(baseConfig, { audit });
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
    } finally {
      await app.close();
    }
  });
});

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
