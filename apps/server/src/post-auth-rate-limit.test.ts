import type { AuditLogger } from "@omxterm/core/audit";
import {
  InMemoryFixedWindowRateLimiter,
  type Clock,
} from "@omxterm/core/stores";
import { describe, expect, test } from "vitest";
import type { ServerConfig } from "./config";
import {
  createOmxtermServer,
  MAX_HOST_KEY_PROBES_PER_WINDOW,
  MAX_TICKETS_PER_WINDOW,
  POST_AUTH_RATE_WINDOW_MS,
} from "./server";

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
const remoteAddress = "203.0.113.126";
const HIGH_ROTATION_ATTEMPTS = 20_000;

function createClock(start = 1_000): Clock & { advance(ms: number): void } {
  let now = start;
  return {
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
  };
}

function cookieHeader(setCookie: string | string[] | undefined): string {
  if (!setCookie) throw new Error("Expected login to set auth cookies.");
  const values = Array.isArray(setCookie) ? setCookie : [setCookie];
  return values.map((value) => value.split(";", 1)[0]).join("; ");
}

async function loginWithRotatedSession(
  app: Awaited<ReturnType<typeof createOmxtermServer>>,
): Promise<string> {
  const login = await app.inject({
    method: "POST",
    url: "/api/access",
    remoteAddress,
    headers: { origin: config.allowedOrigins[0] },
    payload: { accessToken: config.accessToken },
  });
  expect(login.statusCode).toBe(200);
  return cookieHeader(login.headers["set-cookie"]);
}

const rateLimitedRoutes = [
  {
    name: "host-key probes",
    url: "/api/ssh/host-key",
    maxRequests: MAX_HOST_KEY_PROBES_PER_WINDOW,
    allowedStatus: 400,
    payload: {},
  },
  {
    name: "terminal tickets",
    url: "/api/terminal-ticket",
    maxRequests: MAX_TICKETS_PER_WINDOW,
    allowedStatus: 200,
    payload: {
      host: "127.0.0.1",
      port: 22,
      username: "test-user",
      privateKey: "test-private-key",
      acceptedHostFingerprint: "SHA256:test",
    },
  },
] as const;

describe("post-auth per-client rate limits", () => {
  test.each(rateLimitedRoutes)(
    "keeps the $name budget exhausted across rotated sessions",
    async ({ url, maxRequests, allowedStatus, payload }) => {
      const app = await createOmxtermServer(config, { audit: discardAudit });
      try {
        for (let attempt = 0; attempt < maxRequests; attempt++) {
          const cookie = await loginWithRotatedSession(app);
          const response = await app.inject({
            method: "POST",
            url,
            remoteAddress,
            headers: { origin: config.allowedOrigins[0], cookie },
            payload,
          });
          expect(response.statusCode).toBe(allowedStatus);
        }

        const cookie = await loginWithRotatedSession(app);
        const blocked = await app.inject({
          method: "POST",
          url,
          remoteAddress,
          headers: { origin: config.allowedOrigins[0], cookie },
          payload,
        });

        expect(blocked.statusCode).toBe(429);
        expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
      } finally {
        await app.close();
      }
    },
  );

  test("keeps limiter windows bounded during high denied session rotation", async () => {
    const clock = createClock();
    const ticketRateLimiter = new InMemoryFixedWindowRateLimiter(
      clock,
      MAX_TICKETS_PER_WINDOW,
      POST_AUTH_RATE_WINDOW_MS,
    );
    const app = await createOmxtermServer(config, {
      audit: discardAudit,
      ticketRateLimiter,
    });

    try {
      for (let attempt = 0; attempt < MAX_TICKETS_PER_WINDOW; attempt++) {
        const cookie = await loginWithRotatedSession(app);
        const allowed = await app.inject({
          method: "POST",
          url: "/api/terminal-ticket",
          remoteAddress,
          headers: { origin: config.allowedOrigins[0], cookie },
          payload: rateLimitedRoutes[1].payload,
        });
        expect(allowed.statusCode).toBe(200);
      }

      for (let attempt = 0; attempt < HIGH_ROTATION_ATTEMPTS; attempt++) {
        const cookie = await loginWithRotatedSession(app);
        const blocked = await app.inject({
          method: "POST",
          url: "/api/terminal-ticket",
          remoteAddress,
          headers: { origin: config.allowedOrigins[0], cookie },
          payload: rateLimitedRoutes[1].payload,
        });
        expect(blocked.statusCode).toBe(429);
      }

      clock.advance(POST_AUTH_RATE_WINDOW_MS);
      expect(ticketRateLimiter.sweepExpired()).toBe(
        MAX_TICKETS_PER_WINDOW + 1,
      );
    } finally {
      await app.close();
    }
  });
});
