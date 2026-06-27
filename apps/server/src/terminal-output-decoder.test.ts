import { describe, expect, test } from 'vitest';
import { createUtf8StreamDecoder } from './terminal-output-decoder';

describe('createUtf8StreamDecoder', () => {
  // Regression: a 3-byte glyph (█ = E2 96 88) split across two PTY chunks used
  // to surface as two U+FFFD boxes. The decoder must reassemble it instead.
  test('reassembles a multi-byte character split across two chunks', () => {
    const decode = createUtf8StreamDecoder();
    const block = Buffer.from('█', 'utf8');

    const first = decode(block.subarray(0, 2));
    const second = decode(block.subarray(2));

    expect(first + second).toBe('█');
    expect(first + second).not.toContain('�');
  });

  test('reassembles a character split byte by byte', () => {
    const decode = createUtf8StreamDecoder();
    const block = Buffer.from('█', 'utf8');

    const out = decode(block.subarray(0, 1)) + decode(block.subarray(1, 2)) + decode(block.subarray(2, 3));

    expect(out).toBe('█');
  });

  test('decodes accented PT-BR text that fits in a single chunk', () => {
    const decode = createUtf8StreamDecoder();
    expect(decode(Buffer.from('coração', 'utf8'))).toBe('coração');
  });

  test('passes already-decoded strings through unchanged', () => {
    const decode = createUtf8StreamDecoder();
    expect(decode('plain ascii')).toBe('plain ascii');
  });

  test('keeps separate streams independent', () => {
    const decodeStdout = createUtf8StreamDecoder();
    const decodeStderr = createUtf8StreamDecoder();
    const block = Buffer.from('█', 'utf8');

    // A half-character left pending on stdout must not be corrupted by stderr.
    const stdoutHalf = decodeStdout(block.subarray(0, 2));
    const stderrText = decodeStderr(Buffer.from('error', 'utf8'));
    const stdoutRest = decodeStdout(block.subarray(2));

    expect(stdoutHalf + stdoutRest).toBe('█');
    expect(stderrText).toBe('error');
  });
});
