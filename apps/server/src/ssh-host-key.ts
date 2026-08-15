import { createHash } from 'node:crypto';

export function fingerprintHostKey(key: Buffer): string {
  const digest = createHash('sha256')
    .update(key)
    .digest('base64')
    .replace(/=+$/u, '');
  return `SHA256:${digest}`;
}

export function normalizeFingerprint(fingerprint: string): string {
  return fingerprint.trim().replace(/=+$/u, '');
}

export function matchesHostKeyFingerprint(
  key: Buffer,
  acceptedFingerprint: string,
): boolean {
  return (
    normalizeFingerprint(fingerprintHostKey(key)) ===
    normalizeFingerprint(acceptedFingerprint)
  );
}
