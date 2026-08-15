import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { resolveWebRoot, validateAccessToken } from './config';

const SYNTHETIC_DOCUMENTED_BASE64_TOKEN =
  'XxO7pNf4fMEmg2B1nykYzL6JkC8dQvH3Wa9sTu0rPiE=';

function captureValidationError(token: string): Error | undefined {
  try {
    validateAccessToken(token);
  } catch (error) {
    if (error instanceof Error) return error;
  }
  return undefined;
}

describe('validateAccessToken', () => {
  test('returns a documented Base64-format token unchanged', () => {
    expect(validateAccessToken(SYNTHETIC_DOCUMENTED_BASE64_TOKEN)).toBe(
      SYNTHETIC_DOCUMENTED_BASE64_TOKEN,
    );
  });

  test.each([
    { kind: 'ASCII spaces', submittedToken: ' '.repeat(24) },
    { kind: 'Unicode NEXT LINE', submittedToken: '\u0085'.repeat(24) },
    { kind: 'byte-order marks', submittedToken: '\uFEFF'.repeat(24) },
  ])('rejects all-$kind tokens without exposing their value', ({ submittedToken }) => {
    const validationError = captureValidationError(submittedToken);

    expect(validationError).toBeDefined();
    expect(validationError?.message).not.toContain(submittedToken);
  });

  test.each([
    { boundary: 'leading tab', token: `\t${SYNTHETIC_DOCUMENTED_BASE64_TOKEN}` },
    {
      boundary: 'leading Unicode NEXT LINE',
      token: `\u0085${SYNTHETIC_DOCUMENTED_BASE64_TOKEN}`,
    },
    {
      boundary: 'trailing newline',
      token: `${SYNTHETIC_DOCUMENTED_BASE64_TOKEN}\n`,
    },
    {
      boundary: 'trailing Unicode NEXT LINE',
      token: `${SYNTHETIC_DOCUMENTED_BASE64_TOKEN}\u0085`,
    },
  ])('rejects $boundary whitespace', ({ token }) => {
    expect(() => validateAccessToken(token)).toThrow(/OMXTERM_ACCESS_TOKEN/);
  });

  test('rejects known weak placeholders regardless of case or padding', () => {
    expect(() => validateAccessToken('change-me')).toThrow(/OMXTERM_ACCESS_TOKEN/);
    expect(() => validateAccessToken('Change-Me')).toThrow(/OMXTERM_ACCESS_TOKEN/);
    expect(() => validateAccessToken('  Change-Me  ')).toThrow(/OMXTERM_ACCESS_TOKEN/);
    expect(() => validateAccessToken('password')).toThrow(/OMXTERM_ACCESS_TOKEN/);
  });

  test('rejects case-insensitive exact repetitions of a weak placeholder', () => {
    const submittedToken = 'PasswordPASSWORDpassword';
    const validationError = captureValidationError(submittedToken);

    expect(validationError).toBeDefined();
    expect(validationError?.message).not.toContain(submittedToken);
  });

  test('accepts a value that is not an exact weak-placeholder repetition', () => {
    const token = 'passwordpasswordpassword!';

    expect(validateAccessToken(token)).toBe(token);
  });

  test('rejects one code unit below the minimum without exposing its value', () => {
    const submittedToken = 'x'.repeat(23);
    const validationError = captureValidationError(submittedToken);

    expect(validationError).toBeDefined();
    expect(validationError?.message).not.toContain(submittedToken);
  });

  test('accepts a repeated non-placeholder at the 24-code-unit minimum', () => {
    const token = 'x'.repeat(24);

    expect(validateAccessToken(token)).toBe(token);
  });

  test('preserves the existing UTF-16 code-unit minimum semantics', () => {
    const twelveCodePointToken = '🔐'.repeat(12);

    expect(twelveCodePointToken).toHaveLength(24);
    expect(validateAccessToken(twelveCodePointToken)).toBe(twelveCodePointToken);
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
