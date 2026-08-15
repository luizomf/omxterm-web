import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
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
  let fixtureRoot: string;

  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'omxterm-web-root-'));
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  test('returns undefined when unset, so dev keeps serving the web from Vite', () => {
    expect(resolveWebRoot(undefined)).toBeUndefined();
    expect(resolveWebRoot('')).toBeUndefined();
  });

  test('canonicalizes a root symlink whose target is a usable SPA directory', () => {
    const builtSpa = join(fixtureRoot, 'dist');
    const configuredRoot = join(fixtureRoot, 'current');
    mkdirSync(builtSpa);
    writeFileSync(join(builtSpa, 'index.html'), '<main>synthetic SPA</main>');
    symlinkSync(builtSpa, configuredRoot, 'dir');

    expect(resolveWebRoot(configuredRoot)).toBe(realpathSync(builtSpa));
  });

  test('rejects a configured root that is a regular file', () => {
    const fileRoot = join(fixtureRoot, 'not-a-directory');
    writeFileSync(fileRoot, 'synthetic public content');

    expect(() => resolveWebRoot(fileRoot)).toThrow(/OMXTERM_WEB_ROOT/);
  });

  test('rejects a directory without index.html', () => {
    const emptyRoot = join(fixtureRoot, 'empty-dist');
    mkdirSync(emptyRoot);

    expect(() => resolveWebRoot(emptyRoot)).toThrow(/OMXTERM_WEB_ROOT/);
  });

  test('rejects a non-regular index.html', () => {
    const builtSpa = join(fixtureRoot, 'dist-with-directory-index');
    mkdirSync(join(builtSpa, 'index.html'), { recursive: true });

    expect(() => resolveWebRoot(builtSpa)).toThrow(/OMXTERM_WEB_ROOT/);
  });

  test('rejects index.html when it is a symlink', () => {
    const builtSpa = join(fixtureRoot, 'dist-with-symlink-index');
    const indexTarget = join(fixtureRoot, 'synthetic-index.html');
    mkdirSync(builtSpa);
    writeFileSync(indexTarget, '<main>synthetic SPA</main>');
    symlinkSync(indexTarget, join(builtSpa, 'index.html'));

    expect(() => resolveWebRoot(builtSpa)).toThrow(/OMXTERM_WEB_ROOT/);
  });

  test('rejects an unreadable index.html', () => {
    const builtSpa = join(fixtureRoot, 'dist-with-unreadable-index');
    const indexPath = join(builtSpa, 'index.html');
    mkdirSync(builtSpa);
    writeFileSync(indexPath, '<main>synthetic SPA</main>');
    chmodSync(indexPath, 0o000);

    try {
      expect(() => resolveWebRoot(builtSpa)).toThrow(/OMXTERM_WEB_ROOT/);
    } finally {
      chmodSync(indexPath, 0o600);
    }
  });

  test('rejects a missing path without disclosing the configured value', () => {
    const missing = join(fixtureRoot, 'synthetic-dist-that-is-absent');
    let failure: unknown;

    try {
      resolveWebRoot(missing);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/OMXTERM_WEB_ROOT/);
    expect((failure as Error).message).not.toContain(missing);
  });
});
