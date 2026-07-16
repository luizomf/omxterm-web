import type { AuditEvent } from "@omxterm/core/audit";
import { InMemoryAccessCredentialStore } from "@omxterm/core/stores";
import { describe, expect, test } from "vitest";
import type { ServerConfig } from "./config";
import {
  createOmxtermServer,
  MAX_ACCESS_GRANT_AUDITS_PER_DIRECT_PEER_PER_WINDOW,
  MAX_ACCESS_SESSIONS_PER_CLIENT,
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

type ClientLocation = { remoteAddress: string; forwardedFor?: string };

function createAccessCredentials(): InMemoryAccessCredentialStore {
  return new InMemoryAccessCredentialStore(
    undefined,
    12 * 60 * 60 * 1000,
    MAX_ACCESS_SESSIONS_PER_CLIENT,
  );
}

function accessAttempt(
  app: Awaited<ReturnType<typeof createOmxtermServer>>,
  serverConfig: ServerConfig,
  client: ClientLocation,
) {
  return app.inject({
    method: "POST",
    url: "/api/access",
    headers: {
      origin: serverConfig.allowedOrigins[0],
      ...(client.forwardedFor
        ? { "x-forwarded-for": client.forwardedFor }
        : {}),
    },
    remoteAddress: client.remoteAddress,
    payload: { accessToken: serverConfig.accessToken },
  });
}

function cookieHeader(setCookie: string | string[] | undefined): string {
  if (!setCookie) throw new Error("Expected login to set auth cookies.");
  const values = Array.isArray(setCookie) ? setCookie : [setCookie];
  return values.map((value) => value.split(";", 1)[0]).join("; ");
}

async function isAuthenticated(
  app: Awaited<ReturnType<typeof createOmxtermServer>>,
  cookie: string,
): Promise<boolean> {
  const response = await app.inject({
    method: "GET",
    url: "/api/me",
    headers: { origin: config.allowedOrigins[0], cookie },
  });
  return response.json<{ authenticated: boolean }>().authenticated;
}

function expectBoundedCredentialCounts(
  accessCredentials: InMemoryAccessCredentialStore,
  clients = 1,
): void {
  const expectedPairs = MAX_ACCESS_SESSIONS_PER_CLIENT * clients;
  expect(accessCredentials.getLiveCredentialCounts()).toEqual({
    clients,
    sessions: expectedPairs,
    devices: expectedPairs,
    ownerships: expectedPairs,
  });
}

describe("successful access-session rotation", () => {
  test("rotates beyond capacity while bounding paired live state", async () => {
    const accessCredentials = createAccessCredentials();
    const app = await createOmxtermServer(config, {
      accessCredentials,
      audit: { write: () => {} },
    });
    const cookies: string[] = [];

    try {
      for (
        let attempt = 0;
        attempt < MAX_ACCESS_SESSIONS_PER_CLIENT + 3;
        attempt++
      ) {
        const response = await accessAttempt(app, config, {
          remoteAddress: "203.0.113.145",
          forwardedFor: `198.51.100.${attempt}`,
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ ok: true });
        cookies.push(cookieHeader(response.headers["set-cookie"]));
      }

      const authenticationStates = await Promise.all(
        cookies.map((cookie) => isAuthenticated(app, cookie)),
      );
      expect(authenticationStates).toEqual([
        false,
        false,
        false,
        ...Array.from(
          { length: MAX_ACCESS_SESSIONS_PER_CLIENT },
          () => true,
        ),
      ]);
      expectBoundedCredentialCounts(accessCredentials);

      for (const url of ["/api/ssh/host-key", "/api/terminal-ticket"]) {
        const revokedRequest = await app.inject({
          method: "POST",
          url,
          headers: {
            origin: config.allowedOrigins[0],
            cookie: cookies[0],
          },
          payload: {},
        });
        expect(revokedRequest.statusCode).toBe(401);
        expect(revokedRequest.json()).toEqual({
          ok: false,
          message: "Unauthorized.",
        });
      }
    } finally {
      await app.close();
    }
  });

  test("keeps the bound under concurrent successful rotations", async () => {
    const accessCredentials = createAccessCredentials();
    const app = await createOmxtermServer(config, {
      accessCredentials,
      audit: { write: () => {} },
    });

    try {
      const responses = await Promise.all(
        Array.from({ length: 50 }, () =>
          accessAttempt(app, config, { remoteAddress: "203.0.113.146" }),
        ),
      );
      expect(responses.every((response) => response.statusCode === 200)).toBe(
        true,
      );
      const authenticationStates = await Promise.all(
        responses.map((response) =>
          isAuthenticated(app, cookieHeader(response.headers["set-cookie"])),
        ),
      );
      expect(authenticationStates.filter(Boolean)).toHaveLength(
        MAX_ACCESS_SESSIONS_PER_CLIENT,
      );
      expectBoundedCredentialCounts(accessCredentials);
    } finally {
      await app.close();
    }
  });

  test("uses trusted forwarded identity without proxy clients evicting each other", async () => {
    const trustedProxyAddress = "10.0.0.146";
    const proxyConfig: ServerConfig = {
      ...config,
      trustProxy: trustedProxyAddress,
    };
    const accessCredentials = createAccessCredentials();
    const app = await createOmxtermServer(proxyConfig, {
      accessCredentials,
      audit: { write: () => {} },
    });
    const cookiesByClient = new Map<string, string[]>();

    try {
      for (const forwardedFor of ["198.51.100.145", "198.51.100.146"]) {
        const cookies: string[] = [];
        for (
          let attempt = 0;
          attempt < MAX_ACCESS_SESSIONS_PER_CLIENT;
          attempt++
        ) {
          const response = await accessAttempt(app, proxyConfig, {
            remoteAddress: trustedProxyAddress,
            forwardedFor,
          });
          expect(response.statusCode).toBe(200);
          cookies.push(cookieHeader(response.headers["set-cookie"]));
        }
        cookiesByClient.set(forwardedFor, cookies);
      }

      const extraLogin = await accessAttempt(app, proxyConfig, {
        remoteAddress: trustedProxyAddress,
        forwardedFor: "198.51.100.145",
      });
      expect(extraLogin.statusCode).toBe(200);
      expect(
        await isAuthenticated(
          app,
          cookiesByClient.get("198.51.100.145")?.[0] ?? "",
        ),
      ).toBe(false);
      expect(
        await isAuthenticated(
          app,
          cookiesByClient.get("198.51.100.146")?.[0] ?? "",
        ),
      ).toBe(true);
      expectBoundedCredentialCounts(accessCredentials, 2);
    } finally {
      await app.close();
    }
  });

  test("bounds access-granted audits by direct peer under forwarded rotation", async () => {
    const events: Omit<AuditEvent, "ts">[] = [];
    const trustedProxyAddress = "10.0.0.145";
    const proxyConfig: ServerConfig = {
      ...config,
      trustProxy: trustedProxyAddress,
    };
    const app = await createOmxtermServer(proxyConfig, {
      audit: {
        write: (event) => {
          events.push(event);
        },
      },
    });

    try {
      for (
        let attempt = 0;
        attempt <
        MAX_ACCESS_GRANT_AUDITS_PER_DIRECT_PEER_PER_WINDOW + 7;
        attempt++
      ) {
        const response = await accessAttempt(app, proxyConfig, {
          remoteAddress: trustedProxyAddress,
          forwardedFor: `198.51.100.${attempt}`,
        });
        expect(response.statusCode).toBe(200);
      }

      expect(events).toHaveLength(
        MAX_ACCESS_GRANT_AUDITS_PER_DIRECT_PEER_PER_WINDOW,
      );
      expect(
        events.every(
          (event) =>
            event.event === "access_granted" &&
            Object.keys(event).sort().join(",") ===
              "event,origin,sessionId,severity",
        ),
      ).toBe(true);
      const serializedEvents = JSON.stringify(events);
      expect(serializedEvents).not.toContain(proxyConfig.accessToken);
      expect(serializedEvents).not.toContain(trustedProxyAddress);
      expect(serializedEvents).not.toContain("198.51.100");
      expect(serializedEvents.toLowerCase()).not.toContain("cookie");
    } finally {
      await app.close();
    }
  });
});
