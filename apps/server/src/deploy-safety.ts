import { isIP } from "node:net";

// Deploy-safety guards for running the broker outside localhost (#5). The auth
// cookies ARE the authentication, so two things must hold behind a reverse
// proxy: Fastify must trust the proxy (so request.ip is the real client and
// X-Forwarded-Proto reflects HTTPS), and the broker must refuse to ship those
// cookies in cleartext on a public bind.

// Fastify's trustProxy accepts boolean | number (hop count) | string (a comma
// separated IP/CIDR allowlist of trusted proxies). Default false so a directly
// exposed dev server never honors spoofable X-Forwarded-* headers.
export function parseTrustProxy(
  raw: string | undefined,
): boolean | number | string {
  const value = raw?.trim();
  if (!value) return false;

  const lowered = value.toLowerCase();
  if (lowered === "true") return true;
  if (lowered === "false") return false;

  // A bare non-negative integer means "trust this many proxy hops".
  const hops = Number(value);
  if (Number.isInteger(hops) && hops >= 0) return hops;

  // Otherwise treat it as an IP/CIDR allowlist and let Fastify parse it. This is
  // the safest option in production: trust only the known proxy address.
  return value;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

// Loopback binds keep traffic on the local machine, so cleartext cookies never
// leave the host. 0.0.0.0 / a LAN IP / a public IP are NOT loopback and are the
// cases the cookie guard exists to catch.
export function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase();
  return (
    LOOPBACK_HOSTS.has(value) || (isIP(value) === 4 && value.startsWith("127."))
  );
}

// Refuse to boot when auth cookies would travel in cleartext: secure cookies
// off while binding to a non-loopback host. Forces an explicit, correct deploy
// (HTTPS/WSS + OMXTERM_SECURE_COOKIES=true) instead of a silent footgun.
export function assertSafeCookieDeployment(deployment: {
  host: string;
  secureCookies: boolean;
}): void {
  if (deployment.secureCookies || isLoopbackHost(deployment.host)) return;
  throw new Error(
    `Refusing to boot: OMXTERM_SECURE_COOKIES is false while binding to the ` +
      `non-loopback host "${deployment.host}". The auth cookies are the ` +
      `authentication and would travel in cleartext. Put OMXTerm behind ` +
      `HTTPS/WSS and set OMXTERM_SECURE_COOKIES=true, or bind to a loopback ` +
      `host. See the README "Deploy" section.`,
  );
}
