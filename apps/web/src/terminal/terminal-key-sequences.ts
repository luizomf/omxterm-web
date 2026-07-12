// Escape/control sequences for the on-screen key bar (#21). These are plain
// ANSI/VT sequences the SSH target's shell/readline already understands, so no
// server protocol change is needed — they travel through the same `input`
// message as any other keystroke.

export const ESCAPE_SEQUENCE = '\x1b';
export const TAB_SEQUENCE = '\t';
export const ARROW_UP_SEQUENCE = '\x1b[A';
export const ARROW_DOWN_SEQUENCE = '\x1b[B';
export const ARROW_RIGHT_SEQUENCE = '\x1b[C';
export const ARROW_LEFT_SEQUENCE = '\x1b[D';

const LOWERCASE_A_CODE = 'a'.charCodeAt(0);
const LOWERCASE_Z_CODE = 'z'.charCodeAt(0);

/**
 * Returns the control character for Ctrl+<letter> (a-z, case-insensitive), or
 * null when `letter` is not a single latin letter. Control characters follow
 * the standard ASCII layout: Ctrl+A is 0x01 through Ctrl+Z is 0x1A.
 *
 * @example
 * controlCharacterFor('c'); // '\x03' (Ctrl-C / SIGINT)
 * controlCharacterFor('d'); // '\x04' (Ctrl-D / EOF)
 * controlCharacterFor('1'); // null — not a letter
 */
export function controlCharacterFor(letter: string): string | null {
  if (letter.length !== 1) return null;

  const lowerCode = letter.toLowerCase().charCodeAt(0);
  if (lowerCode < LOWERCASE_A_CODE || lowerCode > LOWERCASE_Z_CODE) return null;

  const controlCode = lowerCode - LOWERCASE_A_CODE + 1;
  return String.fromCharCode(controlCode);
}

// Ctrl-C is exposed as its own named constant (rather than only via
// controlCharacterFor) because the key bar's Ctrl-C button is a fixed
// shortcut, not a derived sticky-modifier result.
export const CTRL_C_SEQUENCE = '\x03';

export type StickyCtrlResult = {
  /** Next armed state — always false: sticky Ctrl is a one-shot modifier. */
  armed: boolean;
  /** The bytes to actually send to the terminal transport. */
  output: string;
};

/**
 * Applies the key bar's sticky Ctrl modifier to a chunk of data xterm reports
 * from `onData`. When armed and the chunk is a single Ctrl-able letter, the
 * control character replaces it and the modifier disarms. Any other input
 * (multi-character paste, arrow escape sequences, punctuation, Enter, etc.)
 * disarms the modifier and passes through unchanged, mirroring how a mobile
 * keyboard's one-shot Shift key gives up after one keystroke.
 */
export function applyStickyCtrlModifier(
  data: string,
  armed: boolean,
): StickyCtrlResult {
  if (!armed) return { armed: false, output: data };

  const controlChar = controlCharacterFor(data);
  if (controlChar === null) return { armed: false, output: data };

  return { armed: false, output: controlChar };
}
