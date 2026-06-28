// Origin allowlist for the broker's CSWSH defense. A browser cannot forge the
// Origin header from page JS, so an exact-match allowlist is what stops a
// malicious site from driving a victim's authenticated terminal session.
// Matching is exact per entry — no wildcards, no substrings — so widening the
// list (e.g. localhost + a LAN IP, see #14) never weakens the check. This does
// NOT control who can reach the broker on the network (that is the bind host,
// OMXTERM_SERVER_HOST) nor protect tokens in transit (that is HTTPS, see #5).

const ALLOWED_ORIGIN_HINT =
  "Set OMXTERM_ALLOWED_ORIGIN to a comma-separated list of exact origins, each " +
  '"scheme://host[:port]" with no path or trailing slash, e.g. ' +
  '"http://localhost:5173,http://192.168.0.10:5173". Wildcards are not allowed.';

/**
 * Parse the comma-separated OMXTERM_ALLOWED_ORIGIN value into an allowlist.
 *
 * Fails closed at boot: blank entries are dropped, and an empty result, the `*`
 * wildcard, or any malformed origin throws instead of silently allowing nothing
 * (or, worse, everything). A single value stays supported (a list of one).
 *
 * @example parseAllowedOrigins('http://localhost:5173, http://192.168.0.10:5173')
 */
export function parseAllowedOrigins(rawValue: string): string[] {
  const origins = rawValue
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (origins.length === 0) {
    throw new Error(
      `OMXTERM_ALLOWED_ORIGIN must list at least one origin. ${ALLOWED_ORIGIN_HINT}`,
    );
  }

  for (const origin of origins) {
    assertExactOrigin(origin);
  }

  return origins;
}

/**
 * Whether a request Origin header is in the allowlist. Acts as a type guard so
 * callers can keep using the validated value as a defined string.
 */
export function isOriginAllowed(
  origin: string | undefined,
  allowedOrigins: string[],
): origin is string {
  return origin !== undefined && allowedOrigins.includes(origin);
}

function assertExactOrigin(value: string): void {
  if (value === "*") {
    throw new Error(
      `OMXTERM_ALLOWED_ORIGIN does not allow the wildcard "*". ${ALLOWED_ORIGIN_HINT}`,
    );
  }
  if (!isExactOrigin(value)) {
    throw new Error(
      `OMXTERM_ALLOWED_ORIGIN has an invalid origin "${value}". ${ALLOWED_ORIGIN_HINT}`,
    );
  }
}

function isExactOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    // The Origin header is serialized as scheme://host[:port] with no path,
    // query, fragment, or trailing slash. url.origin reproduces exactly that,
    // so requiring equality rejects anything carrying extra parts (which could
    // never match a real Origin header anyway).
    return url.origin === value;
  } catch {
    return false;
  }
}
