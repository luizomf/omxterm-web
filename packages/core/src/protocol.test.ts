import { describe, expect, test } from 'vitest';
import { createJsonTerminalProtocolCodec } from './protocol';

const codec = createJsonTerminalProtocolCodec();

describe('json terminal protocol codec', () => {
  test('parses valid input messages', () => {
    expect(codec.parseClientMessage(JSON.stringify({ type: 'input', data: 'ls\n' }))).toEqual({ ok: true, message: { type: 'input', data: 'ls\n' } });
  });

  test('rejects invalid JSON safely', () => {
    const result = codec.parseClientMessage('{nope');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_json');
  });

  test('rejects resize outside bounds', () => {
    const result = codec.parseClientMessage(JSON.stringify({ type: 'resize', cols: 9999, rows: 24 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('resize_out_of_bounds');
  });
});
