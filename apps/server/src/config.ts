import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { parseAllowedOrigins } from "./allowed-origins";
import { assertSafeCookieDeployment, parseTrustProxy } from "./deploy-safety";
import {
  parseSshEgressAllowlist,
  type SshEgressPolicy,
} from "./ssh-egress-policy";

for (const dotenvPath of [
  resolve(process.cwd(), ".env"),
  resolve(process.cwd(), "..", "..", ".env"),
]) {
  if (existsSync(dotenvPath)) {
    loadDotenv({ path: dotenvPath, override: false });
  }
}

export type ServerConfig = {
  accessToken: string;
  allowedOrigins: string[];
  host: string;
  port: number;
  secureCookies: boolean;
  trustProxy: boolean | string;
  sshEgressPolicy: SshEgressPolicy;
  auditLogPath: string | undefined;
  webRoot: string | undefined;
};

function getRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

const MIN_ACCESS_TOKEN_LENGTH = 24;

// Defaults and placeholders that would turn the access gate into an open SSH
// proxy if shipped as-is. Compared case-insensitively after boundary whitespace
// validation.
const WEAK_ACCESS_TOKENS = new Set([
  "change-me",
  "changeme",
  "change_me",
  "password",
  "secret",
  "token",
  "admin",
]);

const STRONG_TOKEN_HINT =
  'Generate a strong random token, e.g. "openssl rand -base64 32".';

// ECMAScript trim omits U+0085 NEXT LINE even though Unicode classifies it as
// White_Space. Match the Unicode property plus U+FEFF (which ECMAScript treats
// as whitespace) so boundary padding cannot depend on runtime trim semantics.
const ALL_TOKEN_WHITESPACE = /^[\p{White_Space}\uFEFF]+$/u;
const TOKEN_BOUNDARY_WHITESPACE =
  /(?:^[\p{White_Space}\uFEFF])|(?:[\p{White_Space}\uFEFF]$)/u;

function hasWeakAccessTokenPrimitive(token: string): boolean {
  const normalizedToken = token.toLowerCase();

  // Every vocabulary entry is already primitive. Matching one or more complete
  // copies therefore rejects only tokens whose shortest primitive is known weak.
  for (const weakToken of WEAK_ACCESS_TOKENS) {
    if (
      normalizedToken.length >= weakToken.length &&
      normalizedToken.length % weakToken.length === 0 &&
      normalizedToken ===
        weakToken.repeat(normalizedToken.length / weakToken.length)
    ) {
      return true;
    }
  }
  return false;
}

const WEB_ROOT_CONFIG_HINT =
  "OMXTERM_WEB_ROOT must point to an existing directory containing a readable " +
  "regular non-symlink index.html, or be left unset.";

function invalidWebRoot(): Error {
  // Do not echo an environment-provided filesystem path into startup output.
  return new Error(WEB_ROOT_CONFIG_HINT);
}

// In production the broker serves the built SPA itself (single origin, so the
// browser's relative /api and same-origin wss just work). Opt-in: unset in dev,
// where Vite owns the web. Canonicalize the configured root, then fail at boot
// unless it is a usable built SPA instead of silently serving the wrong tree.
export function resolveWebRoot(value: string | undefined): string | undefined {
  if (!value) return undefined;

  try {
    const canonicalRoot = realpathSync(resolve(value));
    if (!statSync(canonicalRoot).isDirectory()) throw invalidWebRoot();

    const indexPath = join(canonicalRoot, "index.html");
    if (!lstatSync(indexPath).isFile()) throw invalidWebRoot();
    const indexDescriptor = openSync(indexPath, "r");
    closeSync(indexDescriptor);
    return canonicalRoot;
  } catch {
    // Normalize filesystem failures so configured paths never reach startup logs.
    throw invalidWebRoot();
  }
}

export function validateAccessToken(token: string): string {
  if (ALL_TOKEN_WHITESPACE.test(token)) {
    throw new Error(
      `OMXTERM_ACCESS_TOKEN must not be all whitespace. ${STRONG_TOKEN_HINT}`,
    );
  }
  if (TOKEN_BOUNDARY_WHITESPACE.test(token)) {
    throw new Error(
      `OMXTERM_ACCESS_TOKEN must not start or end with whitespace. ${STRONG_TOKEN_HINT}`,
    );
  }
  if (hasWeakAccessTokenPrimitive(token)) {
    throw new Error(
      `OMXTERM_ACCESS_TOKEN is set to a known weak value. ${STRONG_TOKEN_HINT}`,
    );
  }
  if (token.length < MIN_ACCESS_TOKEN_LENGTH) {
    throw new Error(
      `OMXTERM_ACCESS_TOKEN must be at least ${MIN_ACCESS_TOKEN_LENGTH} UTF-16 code units; ` +
        `got ${token.length}. ${STRONG_TOKEN_HINT}`,
    );
  }
  return token;
}

export function loadConfig(): ServerConfig {
  const config: ServerConfig = {
    accessToken: validateAccessToken(getRequiredEnv("OMXTERM_ACCESS_TOKEN")),
    allowedOrigins: parseAllowedOrigins(
      process.env.OMXTERM_ALLOWED_ORIGIN ?? "http://localhost:5173",
    ),
    host: process.env.OMXTERM_SERVER_HOST ?? "127.0.0.1",
    port: Number.parseInt(process.env.OMXTERM_SERVER_PORT ?? "3000", 10),
    secureCookies: process.env.OMXTERM_SECURE_COOKIES === "true",
    trustProxy: parseTrustProxy(process.env.OMXTERM_TRUST_PROXY),
    sshEgressPolicy: parseSshEgressAllowlist(
      process.env.OMXTERM_SSH_ALLOWED_CIDR,
    ),
    auditLogPath: process.env.OMXTERM_AUDIT_LOG,
    webRoot: resolveWebRoot(process.env.OMXTERM_WEB_ROOT),
  };
  assertSafeCookieDeployment(config);
  return config;
}
