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

export function loadConfig(): ServerConfig {
  return {
    accessToken: getRequiredEnv('OMXTERM_ACCESS_TOKEN'),
    allowedOrigin:
      process.env.OMXTERM_ALLOWED_ORIGIN ?? 'http://localhost:5173',
    host: process.env.OMXTERM_SERVER_HOST ?? '127.0.0.1',
    port: Number.parseInt(process.env.OMXTERM_SERVER_PORT ?? '3000', 10),
    secureCookies: process.env.OMXTERM_SECURE_COOKIES === 'true',
    auditLogPath: process.env.OMXTERM_AUDIT_LOG,
  };
}
