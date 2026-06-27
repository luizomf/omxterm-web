import { describe, expect, test } from 'vitest';
import { validateAccessToken } from './config';

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
