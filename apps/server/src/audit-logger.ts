import type { AuditEvent, AuditLogger } from '@omxterm/core/audit';
import { sanitizeAuditMetadata } from '@omxterm/core/audit';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class JsonlAuditLogger implements AuditLogger {
  constructor(private readonly logPath?: string) {}

  write(event: Omit<AuditEvent, 'ts'>): void {
    const payload = sanitizeAuditMetadata({ ts: new Date().toISOString(), ...event });
    const line = `${JSON.stringify(payload)}\n`;
    if (this.logPath) {
      mkdirSync(dirname(this.logPath), { recursive: true });
      appendFileSync(this.logPath, line);
      return;
    }
    process.stdout.write(line);
  }
}
