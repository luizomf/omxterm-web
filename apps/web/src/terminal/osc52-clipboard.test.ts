import { describe, expect, test, vi } from 'vitest';
import { handleOsc52 } from './osc52-clipboard';

describe('handleOsc52', () => {
  test('surfaces the decoded base64 payload as a write request', () => {
    const requestClipboardWrite = vi.fn();
    expect(handleOsc52('c;SGVsbG8=', requestClipboardWrite)).toBe(true);
    expect(requestClipboardWrite).toHaveBeenCalledWith('Hello');
  });

  test('decodes multibyte UTF-8 payloads', () => {
    const requestClipboardWrite = vi.fn();
    // base64 of "olá 🌎"
    handleOsc52('c;b2zDoSDwn4yO', requestClipboardWrite);
    expect(requestClipboardWrite).toHaveBeenCalledWith('olá 🌎');
  });

  test('writes regardless of the selection characters in Pc', () => {
    const requestClipboardWrite = vi.fn();
    handleOsc52('p;SGVsbG8=', requestClipboardWrite);
    expect(requestClipboardWrite).toHaveBeenCalledWith('Hello');
  });

  test('ignores read requests so the host can never read the clipboard', () => {
    const requestClipboardWrite = vi.fn();
    expect(handleOsc52('c;?', requestClipboardWrite)).toBe(true);
    expect(requestClipboardWrite).not.toHaveBeenCalled();
  });

  test('ignores empty payloads so the host cannot clear the clipboard', () => {
    const requestClipboardWrite = vi.fn();
    handleOsc52('c;', requestClipboardWrite);
    expect(requestClipboardWrite).not.toHaveBeenCalled();
  });

  test('ignores malformed payloads without a separator', () => {
    const requestClipboardWrite = vi.fn();
    expect(handleOsc52('garbage', requestClipboardWrite)).toBe(true);
    expect(requestClipboardWrite).not.toHaveBeenCalled();
  });

  test('swallows malformed base64 instead of writing or throwing', () => {
    const requestClipboardWrite = vi.fn();
    expect(handleOsc52('c;not base64!!', requestClipboardWrite)).toBe(true);
    expect(requestClipboardWrite).not.toHaveBeenCalled();
  });

  test('drops decoded clipboard writes larger than 64 KiB', () => {
    const requestClipboardWrite = vi.fn();
    const oversizedPayload = btoa('a'.repeat(64 * 1024 + 1));

    expect(handleOsc52(`c;${oversizedPayload}`, requestClipboardWrite)).toBe(
      true,
    );
    expect(requestClipboardWrite).not.toHaveBeenCalled();
  });

  test('allows a clipboard write at the 64 KiB boundary', () => {
    const requestClipboardWrite = vi.fn();
    const boundaryPayload = btoa('a'.repeat(64 * 1024));

    handleOsc52(`c;${boundaryPayload}`, requestClipboardWrite);
    expect(requestClipboardWrite).toHaveBeenCalledOnce();
  });
});
