import { describe, expect, test } from 'vitest';
import {
  BASE_TERMINAL_FONT_SIZE,
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  clampTerminalFontSize,
  nextTerminalFontSize,
} from './terminal-font-zoom';

describe('clampTerminalFontSize', () => {
  test('keeps a size within range untouched', () => {
    expect(clampTerminalFontSize(16)).toBe(16);
  });

  test('clamps below the minimum', () => {
    expect(clampTerminalFontSize(MIN_TERMINAL_FONT_SIZE - 5)).toBe(MIN_TERMINAL_FONT_SIZE);
  });

  test('clamps above the maximum', () => {
    expect(clampTerminalFontSize(MAX_TERMINAL_FONT_SIZE + 5)).toBe(MAX_TERMINAL_FONT_SIZE);
  });
});

describe('nextTerminalFontSize', () => {
  test('grows on Cmd+= and Cmd++', () => {
    expect(nextTerminalFontSize(16, { withZoomModifier: true, key: '=' })).toBe(17);
    expect(nextTerminalFontSize(16, { withZoomModifier: true, key: '+' })).toBe(17);
  });

  test('shrinks on Cmd+- and Cmd+_', () => {
    expect(nextTerminalFontSize(16, { withZoomModifier: true, key: '-' })).toBe(15);
    expect(nextTerminalFontSize(16, { withZoomModifier: true, key: '_' })).toBe(15);
  });

  test('resets to the base size on Cmd+0', () => {
    expect(nextTerminalFontSize(31, { withZoomModifier: true, key: '0' })).toBe(BASE_TERMINAL_FONT_SIZE);
  });

  test('does not grow past the maximum', () => {
    expect(nextTerminalFontSize(MAX_TERMINAL_FONT_SIZE, { withZoomModifier: true, key: '=' })).toBe(
      MAX_TERMINAL_FONT_SIZE,
    );
  });

  test('does not shrink past the minimum', () => {
    expect(nextTerminalFontSize(MIN_TERMINAL_FONT_SIZE, { withZoomModifier: true, key: '-' })).toBe(
      MIN_TERMINAL_FONT_SIZE,
    );
  });

  test('ignores zoom keys without the modifier so the terminal receives them', () => {
    expect(nextTerminalFontSize(16, { withZoomModifier: false, key: '=' })).toBeNull();
    expect(nextTerminalFontSize(16, { withZoomModifier: false, key: '0' })).toBeNull();
  });

  test('ignores non-zoom keys', () => {
    expect(nextTerminalFontSize(16, { withZoomModifier: true, key: 'a' })).toBeNull();
  });
});
