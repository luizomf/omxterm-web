import type { MouseEvent } from 'react';
import {
  ARROW_DOWN_SEQUENCE,
  ARROW_LEFT_SEQUENCE,
  ARROW_RIGHT_SEQUENCE,
  ARROW_UP_SEQUENCE,
  CTRL_C_SEQUENCE,
  ESCAPE_SEQUENCE,
  TAB_SEQUENCE,
} from './terminal-key-sequences';

export type TerminalKeyBarProps = {
  /** Whether the sticky Ctrl modifier is currently armed for the next keystroke. */
  ctrlArmed: boolean;
  onToggleCtrl(): void;
  onSendSequence(sequence: string): void;
};

// Tapping a bar button must not move focus off the terminal's hidden input —
// on mobile that closes the soft keyboard and stops typing mid-session (#21).
// preventDefault on mousedown blocks the browser's default focus-shift while
// still letting the subsequent click fire normally.
function keepTerminalFocused(event: MouseEvent<HTMLButtonElement>): void {
  event.preventDefault();
}

export function TerminalKeyBar({
  ctrlArmed,
  onToggleCtrl,
  onSendSequence,
}: TerminalKeyBarProps) {
  return (
    <div
      className='terminal-key-bar'
      role='toolbar'
      aria-label='Terminal key shortcuts'
    >
      <button
        type='button'
        onMouseDown={keepTerminalFocused}
        onClick={() => onSendSequence(ESCAPE_SEQUENCE)}
      >
        Esc
      </button>
      <button
        type='button'
        onMouseDown={keepTerminalFocused}
        onClick={() => onSendSequence(TAB_SEQUENCE)}
      >
        Tab
      </button>
      <button
        type='button'
        className='key-bar-ctrl'
        aria-pressed={ctrlArmed}
        onMouseDown={keepTerminalFocused}
        onClick={onToggleCtrl}
      >
        Ctrl
      </button>
      <button
        type='button'
        aria-label='Arrow left'
        onMouseDown={keepTerminalFocused}
        onClick={() => onSendSequence(ARROW_LEFT_SEQUENCE)}
      >
        &larr;
      </button>
      <button
        type='button'
        aria-label='Arrow up'
        onMouseDown={keepTerminalFocused}
        onClick={() => onSendSequence(ARROW_UP_SEQUENCE)}
      >
        &uarr;
      </button>
      <button
        type='button'
        aria-label='Arrow down'
        onMouseDown={keepTerminalFocused}
        onClick={() => onSendSequence(ARROW_DOWN_SEQUENCE)}
      >
        &darr;
      </button>
      <button
        type='button'
        aria-label='Arrow right'
        onMouseDown={keepTerminalFocused}
        onClick={() => onSendSequence(ARROW_RIGHT_SEQUENCE)}
      >
        &rarr;
      </button>
      <button
        type='button'
        onMouseDown={keepTerminalFocused}
        onClick={() => onSendSequence(CTRL_C_SEQUENCE)}
      >
        Ctrl-C
      </button>
    </div>
  );
}
