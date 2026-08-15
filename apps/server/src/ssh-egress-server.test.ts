import type { AuditLogger } from "@omxterm/core/audit";
import { InMemoryTerminalTicketStore } from "@omxterm/core/stores";
import { EventEmitter } from "node:events";
import type { ConnectConfig } from "ssh2";
import { afterEach, describe, expect, test } from "vitest";
import type { ServerConfig } from "./config";
import { DEVICE_TOKEN_COOKIE, SESSION_ID_COOKIE } from "./cookies";
import { createOmxtermServer } from "./server";
import { parseSshEgressAllowlist } from "./ssh-egress-policy";
import type { HostKeyProbeInput } from "./ssh";
import {
  Ssh2Establishment,
  type Ssh2ClientDriver,
  type Ssh2ShellCallback,
} from "./ssh2-establishment";

const origin = "https://omxterm.example";
const config: ServerConfig = {
  accessToken: "strong-access-token-for-egress-tests",
  allowedOrigins: [origin],
  host: "127.0.0.1",
  port: 0,
  secureCookies: true,
  trustProxy: false,
  sshEgressPolicy: parseSshEgressAllowlist("192.0.2.0/24"),
  auditLogPath: undefined,
  webRoot: undefined,
};

const audit: AuditLogger = { write() {} };
const openApps: Array<Awaited<ReturnType<typeof createOmxtermServer>>> = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

async function loginCookieHeader(
  app: Awaited<ReturnType<typeof createOmxtermServer>>,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/access",
    headers: { origin },
    payload: { accessToken: config.accessToken },
  });
  expect(response.statusCode).toBe(200);
  const setCookie = response.headers["set-cookie"];
  const cookies = Array.isArray(setCookie)
    ? setCookie
    : typeof setCookie === "string"
      ? [setCookie]
      : [];
  return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

class CapturingSsh2Client extends EventEmitter implements Ssh2ClientDriver {
  connectedHost: string | undefined;
  authMaterialDisposed = false;

  connect(connectConfig: ConnectConfig): this {
    this.connectedHost = connectConfig.host;
    return this;
  }

  shell(_options: unknown, _callback: Ssh2ShellCallback): this {
    return this;
  }

  disposeAuthMaterial(): boolean {
    this.authMaterialDisposed = true;
    return true;
  }

  isAuthMaterialDisposed(): boolean {
    return this.authMaterialDisposed;
  }

  end(): this {
    return this;
  }

  destroy(): void {}
}

function cookieValue(cookieHeader: string, name: string): string {
  const prefix = `${name}=`;
  const cookie = cookieHeader
    .split("; ")
    .find((candidate) => candidate.startsWith(prefix));
  if (!cookie) throw new Error(`Missing test cookie ${name}.`);
  return cookie.slice(prefix.length);
}

describe("SSH egress pinning at server callers", () => {
  test("passes the first canonical approved address unchanged to host-key probing", async () => {
    let probeInput: HostKeyProbeInput | undefined;
    const app = await createOmxtermServer(config, {
      audit,
      hostResolver: async () => [
        { address: "::ffff:c000:20a", family: 6 },
        { address: "192.0.2.11", family: 4 },
      ],
      hostKeyProbe: async (input) => {
        probeInput = input;
        return { fingerprint: "SHA256:synthetic-fingerprint" };
      },
    });
    openApps.push(app);
    const cookie = await loginCookieHeader(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/ssh/host-key",
      headers: { origin, cookie },
      payload: { host: "ordered.example", port: 2222 },
    });

    expect(response.statusCode).toBe(200);
    expect(probeInput).toEqual({
      host: "ordered.example",
      port: 2222,
      pinnedAddress: "192.0.2.10",
    });
  });

  test("carries the selected canonical scalar through the ticket into the authenticated ssh2 dial", async () => {
    const tickets = new InMemoryTerminalTicketStore();
    const app = await createOmxtermServer(config, {
      audit,
      tickets,
      hostResolver: async () => [
        { address: "0:0:0:0:0:ffff:c000:020a", family: 6 },
        { address: "192.0.2.11", family: 4 },
      ],
    });
    openApps.push(app);
    const cookie = await loginCookieHeader(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/terminal-ticket",
      headers: { origin, cookie },
      payload: {
        host: "ordered.example",
        port: 2222,
        username: "test-user",
        privateKey: "synthetic-test-private-key",
        acceptedHostFingerprint: "SHA256:synthetic-fingerprint",
      },
    });

    expect(response.statusCode).toBe(200);
    const consumed = tickets.consume({
      rawTicket: response.json<{ ticket: string }>().ticket,
      sessionId: cookieValue(cookie, SESSION_ID_COOKIE),
      deviceToken: cookieValue(cookie, DEVICE_TOKEN_COOKIE),
      origin,
    });
    expect(consumed.ok).toBe(true);
    if (!consumed.ok) return;
    expect(consumed.grant.profile.pinnedAddress).toBe("192.0.2.10");

    const client = new CapturingSsh2Client();
    const establishment = new Ssh2Establishment({
      createClient: () => client,
    });
    try {
      establishment.start(
        consumed.grant.profile,
        { cols: 80, rows: 24 },
        () => {},
      );
      expect(client.connectedHost).toBe("192.0.2.10");
    } finally {
      establishment.abort();
    }
  });
});
