import { describe, expect, test } from 'vitest';
import {
  clampTerminalSize,
  createJsonTerminalProtocolCodec,
  TERMINAL_SIZE_BOUNDS,
} from './protocol';

const codec = createJsonTerminalProtocolCodec();

function parseResize(cols: number, rows: number) {
  return codec.parseClientMessage(JSON.stringify({ type: 'resize', cols, rows }));
}

describe('json terminal protocol codec', () => {
  test('parses valid input messages', () => {
    expect(codec.parseClientMessage(JSON.stringify({ type: 'input', data: 'ls\n' }))).toEqual({ ok: true, message: { type: 'input', data: 'ls\n' } });
  });

  test('rejects invalid JSON safely', () => {
    const result = codec.parseClientMessage('{nope');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_json');
  });

  test('accepts and forwards a realistic large 304x128 resize', () => {
    expect(parseResize(304, 128)).toEqual({
      ok: true,
      message: { type: 'resize', cols: 304, rows: 128 },
    });
  });

  test('accepts the exact upper boundary', () => {
    const { maxCols, maxRows } = TERMINAL_SIZE_BOUNDS;
    expect(parseResize(maxCols, maxRows)).toEqual({
      ok: true,
      message: { type: 'resize', cols: maxCols, rows: maxRows },
    });
  });

  test('accepts the exact lower boundary', () => {
    const { minCols, minRows } = TERMINAL_SIZE_BOUNDS;
    expect(parseResize(minCols, minRows)).toEqual({
      ok: true,
      message: { type: 'resize', cols: minCols, rows: minRows },
    });
  });

  test('rejects one column above the upper boundary', () => {
    const { maxCols, maxRows } = TERMINAL_SIZE_BOUNDS;
    const result = parseResize(maxCols + 1, maxRows);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('resize_out_of_bounds');
  });

  test('rejects one row above the upper boundary', () => {
    const { maxCols, maxRows } = TERMINAL_SIZE_BOUNDS;
    const result = parseResize(maxCols, maxRows + 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('resize_out_of_bounds');
  });

  test('rejects one column below the lower boundary', () => {
    const { minCols, minRows } = TERMINAL_SIZE_BOUNDS;
    const result = parseResize(minCols - 1, minRows);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('resize_out_of_bounds');
  });

  test('rejects absurd dimensions', () => {
    const result = parseResize(9999, 9999);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('resize_out_of_bounds');
  });

  test('rejects zero and negative dimensions', () => {
    expect(parseResize(0, 0).ok).toBe(false);
    expect(parseResize(-1, -1).ok).toBe(false);
  });

  test('rejects non-integer dimensions as an invalid message', () => {
    const result = parseResize(80.5, 24);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_message');
  });
});

describe('clampTerminalSize', () => {
  test('passes realistic large dimensions through unchanged', () => {
    expect(clampTerminalSize(304, 128)).toEqual({ cols: 304, rows: 128 });
  });

  test('clamps dimensions above the bounds down to the maximum', () => {
    const { maxCols, maxRows } = TERMINAL_SIZE_BOUNDS;
    expect(clampTerminalSize(9999, 9999)).toEqual({ cols: maxCols, rows: maxRows });
  });

  test('clamps dimensions below the bounds up to the minimum', () => {
    const { minCols, minRows } = TERMINAL_SIZE_BOUNDS;
    expect(clampTerminalSize(1, 1)).toEqual({ cols: minCols, rows: minRows });
  });
});
