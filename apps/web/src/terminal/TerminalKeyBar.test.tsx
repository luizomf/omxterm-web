import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { TerminalKeyBarProps } from './TerminalKeyBar';
import { TerminalKeyBar } from './TerminalKeyBar';

afterEach(() => {
  cleanup();
});

function renderKeyBar(overrides: Partial<TerminalKeyBarProps> = {}) {
  const props: TerminalKeyBarProps = {
    ctrlArmed: false,
    onToggleCtrl: vi.fn(),
    onSendSequence: vi.fn(),
    onFontSizeDecrease: vi.fn(),
    onFontSizeReset: vi.fn(),
    onFontSizeIncrease: vi.fn(),
    ...overrides,
  };
  return { ...render(<TerminalKeyBar {...props} />), props };
}

describe('TerminalKeyBar', () => {
  test('sends the Esc, Tab, and arrow sequences for their buttons', () => {
    const {
      props: { onSendSequence },
    } = renderKeyBar();

    fireEvent.click(screen.getByText('Esc'));
    fireEvent.click(screen.getByText('Tab'));
    fireEvent.click(screen.getByLabelText('Arrow left'));
    fireEvent.click(screen.getByLabelText('Arrow up'));
    fireEvent.click(screen.getByLabelText('Arrow down'));
    fireEvent.click(screen.getByLabelText('Arrow right'));
    fireEvent.click(screen.getByText('Ctrl-C'));

    expect(onSendSequence).toHaveBeenNthCalledWith(1, '\x1b');
    expect(onSendSequence).toHaveBeenNthCalledWith(2, '\t');
    expect(onSendSequence).toHaveBeenNthCalledWith(3, '\x1b[D');
    expect(onSendSequence).toHaveBeenNthCalledWith(4, '\x1b[A');
    expect(onSendSequence).toHaveBeenNthCalledWith(5, '\x1b[B');
    expect(onSendSequence).toHaveBeenNthCalledWith(6, '\x1b[C');
    expect(onSendSequence).toHaveBeenNthCalledWith(7, '\x03');
  });

  test('toggles the sticky Ctrl modifier and reflects armed state via aria-pressed', () => {
    const {
      rerender,
      props: { onToggleCtrl },
    } = renderKeyBar();

    const ctrlButton = screen.getByText('Ctrl');
    expect(ctrlButton).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(ctrlButton);
    expect(onToggleCtrl).toHaveBeenCalledTimes(1);

    rerender(
      <TerminalKeyBar
        ctrlArmed={true}
        onToggleCtrl={onToggleCtrl}
        onSendSequence={vi.fn()}
        onFontSizeDecrease={vi.fn()}
        onFontSizeReset={vi.fn()}
        onFontSizeIncrease={vi.fn()}
      />,
    );
    expect(screen.getByText('Ctrl')).toHaveAttribute('aria-pressed', 'true');
  });

  test('fires the decrease, reset, and increase font-size callbacks', () => {
    const {
      props: { onFontSizeDecrease, onFontSizeReset, onFontSizeIncrease },
    } = renderKeyBar();

    fireEvent.click(screen.getByLabelText('Decrease font size'));
    fireEvent.click(screen.getByLabelText('Reset font size'));
    fireEvent.click(screen.getByLabelText('Increase font size'));

    expect(onFontSizeDecrease).toHaveBeenCalledTimes(1);
    expect(onFontSizeReset).toHaveBeenCalledTimes(1);
    expect(onFontSizeIncrease).toHaveBeenCalledTimes(1);
  });

  test('does not steal focus from an already-focused element on mousedown', () => {
    render(<input aria-label='terminal proxy input' />);
    renderKeyBar();

    const focusedInput = screen.getByLabelText('terminal proxy input');
    focusedInput.focus();
    expect(document.activeElement).toBe(focusedInput);

    fireEvent.mouseDown(screen.getByText('Esc'));
    fireEvent.mouseDown(screen.getByLabelText('Increase font size'));

    expect(document.activeElement).toBe(focusedInput);
  });
});
