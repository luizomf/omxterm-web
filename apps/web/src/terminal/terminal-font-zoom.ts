// Font size is an xterm option, not CSS: the renderer measures each cell from
// `fontSize`, so zooming means changing the option and re-fitting. This module
// keeps that decision pure so it can be tested without a live terminal.

export const BASE_TERMINAL_FONT_SIZE = 22;
export const MIN_TERMINAL_FONT_SIZE = 8;
export const MAX_TERMINAL_FONT_SIZE = 40;

export function clampTerminalFontSize(size: number): number {
  return Math.min(
    MAX_TERMINAL_FONT_SIZE,
    Math.max(MIN_TERMINAL_FONT_SIZE, size),
  );
}

export type ZoomShortcut = {
  /** True when the platform zoom modifier (Cmd) is held. */
  withZoomModifier: boolean;
  /** KeyboardEvent.key value. */
  key: string;
};

/**
 * Returns the next font size for a zoom shortcut, or null when the keystroke is
 * not a zoom shortcut and should be left for the terminal to handle.
 *
 * Cmd+'=' / Cmd+'+' grows, Cmd+'-' / Cmd+'_' shrinks, Cmd+'0' resets to base.
 *
 * @example
 * nextTerminalFontSize(16, { withZoomModifier: true, key: '=' }); // 17
 * nextTerminalFontSize(16, { withZoomModifier: true, key: '0' }); // 16
 * nextTerminalFontSize(16, { withZoomModifier: false, key: '=' }); // null
 */
export function nextTerminalFontSize(
  current: number,
  shortcut: ZoomShortcut,
): number | null {
  if (!shortcut.withZoomModifier) return null;

  if (shortcut.key === '=' || shortcut.key === '+')
    return clampTerminalFontSize(current + 1);
  if (shortcut.key === '-' || shortcut.key === '_')
    return clampTerminalFontSize(current - 1);
  if (shortcut.key === '0') return BASE_TERMINAL_FONT_SIZE;

  return null;
}
