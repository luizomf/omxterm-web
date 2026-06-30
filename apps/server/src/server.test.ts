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
