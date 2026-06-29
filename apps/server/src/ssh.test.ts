import { describe, expect, test } from 'vitest';
import { normalizeFingerprint, sshDialHost } from './ssh';

describe('normalizeFingerprint', () => {
  test('trims padding and whitespace for session fingerprint comparison', () => {
    expect(normalizeFingerprint(' SHA256:abc== ')).toBe('SHA256:abc');
  });
});

describe('sshDialHost', () => {
  test('dials the pinned validated IP instead of the hostname so ssh2 never re-resolves (#26)', () => {
    expect(sshDialHost({ host: 'kvm4.vpn', pinnedAddress: '10.100.0.4' })).toBe('10.100.0.4');
  });

  test('falls back to the hostname when no IP was pinned (unrestricted/localhost demo)', () => {
    expect(sshDialHost({ host: 'localhost' })).toBe('localhost');
  });
});
