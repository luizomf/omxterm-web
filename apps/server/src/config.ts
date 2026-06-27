import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

for (const dotenvPath of [
  resolve(process.cwd(), '.env'),
  resolve(process.cwd(), '..', '..', '.env'),
]) {
  if (existsSync(dotenvPath)) {
    loadDotenv({ path: dotenvPath, override: false });
  }
}

export type ServerConfig = {
  accessToken: string;
  allowedOrigin: string;
  host: string;
  port: number;
  secureCookies: boolean;
  auditLogPath: string | undefined;
};

function getRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

const MIN_ACCESS_TOKEN_LENGTH = 24;

// Defaults and placeholders that would turn the access gate into an open SSH
// proxy if shipped as-is. Compared case-insensitively against the trimmed token.
const WEAK_ACCESS_TOKENS = new Set([
  'change-me',
  'changeme',
  'change_me',
  'password',
  'secret',
  'token',
  'admin',
]);

const STRONG_TOKEN_HINT =
  'Generate a strong random token, e.g. "openssl rand -base64 32".';

export function validateAccessToken(token: string): string {
  if (WEAK_ACCESS_TOKENS.has(token.trim().toLowerCase())) {
    throw new Error(
      `OMXTERM_ACCESS_TOKEN is set to a known weak value. ${STRONG_TOKEN_HINT}`,
    );
  }
  if (token.length < MIN_ACCESS_TOKEN_LENGTH) {
    throw new Error(
      `OMXTERM_ACCESS_TOKEN must be at least ${MIN_ACCESS_TOKEN_LENGTH} characters; ` +
        `got ${token.length}. ${STRONG_TOKEN_HINT}`,
    );
  }
  return token;
}

export function loadConfig(): ServerConfig {
  return {
    accessToken: validateAccessToken(getRequiredEnv('OMXTERM_ACCESS_TOKEN')),
    allowedOrigin:
      process.env.OMXTERM_ALLOWED_ORIGIN ?? 'http://localhost:5173',
    host: process.env.OMXTERM_SERVER_HOST ?? '127.0.0.1',
    port: Number.parseInt(process.env.OMXTERM_SERVER_PORT ?? '3000', 10),
    secureCookies: process.env.OMXTERM_SECURE_COOKIES === 'true',
    auditLogPath: process.env.OMXTERM_AUDIT_LOG,
  };
}
