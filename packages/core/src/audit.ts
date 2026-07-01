export type AuditEventName =
  | 'access_granted'
  | 'access_rejected'
  | 'host_key_rejected'
  | 'ticket_issued'
  | 'ticket_rejected'
  | 'ticket_consumed'
  | 'ws_upgrade_rejected'
  | 'session_started'
  | 'session_ended'
  | 'host_key_presented'
  | 'host_key_trusted'
  | 'host_key_probe_failed'
  | 'ssh_egress_blocked'
  | 'resize';

export type AuditEvent = {
  ts: string;
  event: AuditEventName;
  severity: 'info' | 'warn' | 'error';
  sessionId?: string | undefined;
  reason?: string | undefined;
  origin?: string | undefined;
  host?: string | undefined;
  port?: number | undefined;
  cols?: number | undefined;
  rows?: number | undefined;
  bytesIn?: number | undefined;
  bytesOut?: number | undefined;
};

export type AuditLogger = {
  write(event: Omit<AuditEvent, 'ts'>): void | Promise<void>;
};

const SECRET_KEYS = ['authorization', 'cookie', 'key', 'passphrase', 'password', 'private', 'secret', 'ticket', 'token'];

export function redactAuditValue(key: string, value: unknown): unknown {
  const normalized = key.toLowerCase();
  if (SECRET_KEYS.some((secretKey) => normalized.includes(secretKey))) {
    return '[REDACTED]';
  }
  if (typeof value === 'string' && value.includes('-----BEGIN') && value.includes('PRIVATE KEY')) {
    return '[REDACTED]';
  }
  return value;
}

export function sanitizeAuditMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(metadata).map(([key, value]) => [key, redactAuditValue(key, value)]));
}
