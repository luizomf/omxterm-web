import { describe, expect, test } from 'vitest';
import { normalizeFingerprint } from './ssh';

describe('normalizeFingerprint', () => {
  test('trims padding and whitespace for session fingerprint comparison', () => {
    expect(normalizeFingerprint(' SHA256:abc== ')).toBe('SHA256:abc');
  });
});
