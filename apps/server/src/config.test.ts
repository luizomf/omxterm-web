import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { resolveWebRoot, validateAccessToken } from './config';

const STRONG_TOKEN = 'Qb7t9F2kLmX4wRzP1nVc8yJ6hG3sD5aT';

describe('validateAccessToken', () => {
  test('returns a strong token unchanged', () => {
    expect(validateAccessToken(STRONG_TOKEN)).toBe(STRONG_TOKEN);
  });

  test('rejects known weak placeholders regardless of case or padding', () => {
    expect(() => validateAccessToken('change-me')).toThrow(/OMXTERM_ACCESS_TOKEN/);
    expect(() => validateAccessToken('  Change-Me  ')).toThrow(/OMXTERM_ACCESS_TOKEN/);
    expect(() => validateAccessToken('password')).toThrow(/OMXTERM_ACCESS_TOKEN/);
  });

  test('rejects tokens shorter than the minimum length', () => {
    expect(() => validateAccessToken('short-token')).toThrow(/OMXTERM_ACCESS_TOKEN/);
  });
});

describe('resolveWebRoot', () => {
  test('returns undefined when unset, so dev keeps serving the web from Vite', () => {
    expect(resolveWebRoot(undefined)).toBeUndefined();
    expect(resolveWebRoot('')).toBeUndefined();
  });

  test('returns the absolute path for an existing directory', () => {
    expect(resolveWebRoot(tmpdir())).toBe(resolve(tmpdir()));
  });

  test('throws with the offending path when the directory does not exist', () => {
    const missing = resolve(tmpdir(), 'omxterm-web-root-does-not-exist');
    expect(() => resolveWebRoot(missing)).toThrow(/OMXTERM_WEB_ROOT/);
    expect(() => resolveWebRoot(missing)).toThrow(missing);
  });
});
