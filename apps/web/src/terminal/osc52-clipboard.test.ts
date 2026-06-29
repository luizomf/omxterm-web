import { describe, expect, test, vi } from 'vitest';
import { handleOsc52 } from './osc52-clipboard';

describe('handleOsc52', () => {
  test('writes the decoded base64 payload to the clipboard', () => {
    const writeClipboard = vi.fn();
    expect(handleOsc52('c;SGVsbG8=', writeClipboard)).toBe(true);
    expect(writeClipboard).toHaveBeenCalledWith('Hello');
  });

  test('decodes multibyte UTF-8 payloads', () => {
    const writeClipboard = vi.fn();
    // base64 of "olá 🌎"
    handleOsc52('c;b2zDoSDwn4yO', writeClipboard);
    expect(writeClipboard).toHaveBeenCalledWith('olá 🌎');
  });

  test('writes regardless of the selection characters in Pc', () => {
    const writeClipboard = vi.fn();
    handleOsc52('p;SGVsbG8=', writeClipboard);
    expect(writeClipboard).toHaveBeenCalledWith('Hello');
  });

  test('ignores read requests so the host can never read the clipboard', () => {
    const writeClipboard = vi.fn();
    expect(handleOsc52('c;?', writeClipboard)).toBe(true);
    expect(writeClipboard).not.toHaveBeenCalled();
  });

  test('ignores empty payloads so the host cannot clear the clipboard', () => {
    const writeClipboard = vi.fn();
    handleOsc52('c;', writeClipboard);
    expect(writeClipboard).not.toHaveBeenCalled();
  });

  test('ignores malformed payloads without a separator', () => {
    const writeClipboard = vi.fn();
    expect(handleOsc52('garbage', writeClipboard)).toBe(true);
    expect(writeClipboard).not.toHaveBeenCalled();
  });

  test('swallows malformed base64 instead of writing or throwing', () => {
    const writeClipboard = vi.fn();
    expect(handleOsc52('c;not base64!!', writeClipboard)).toBe(true);
    expect(writeClipboard).not.toHaveBeenCalled();
  });
});
