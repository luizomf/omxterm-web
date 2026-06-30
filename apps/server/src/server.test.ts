import { describe, expect, test } from "vitest";
import { createOmxtermServer } from "./server";
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
});
