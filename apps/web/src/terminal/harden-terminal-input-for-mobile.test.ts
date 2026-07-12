import { describe, expect, test } from 'vitest';
import { hardenTerminalInputForMobile } from './harden-terminal-input-for-mobile';

function containerWithHelperTextarea(): HTMLElement {
  const container = document.createElement('div');
  const helperTextarea = document.createElement('textarea');
  helperTextarea.className = 'xterm-helper-textarea';
  container.appendChild(helperTextarea);
  return container;
}

describe('hardenTerminalInputForMobile', () => {
  test('disables autocomplete, autocorrect, autocapitalize, and spellcheck', () => {
    const container = containerWithHelperTextarea();

    hardenTerminalInputForMobile(container);

    const helperTextarea = container.querySelector('.xterm-helper-textarea');
    expect(helperTextarea).toHaveAttribute('autocomplete', 'off');
    expect(helperTextarea).toHaveAttribute('autocorrect', 'off');
    expect(helperTextarea).toHaveAttribute('autocapitalize', 'off');
    expect(helperTextarea).toHaveAttribute('inputmode', 'text');
    expect((helperTextarea as HTMLTextAreaElement).spellcheck).toBe(false);
  });

  test('does nothing when xterm has not rendered its helper textarea yet', () => {
    const container = document.createElement('div');

    expect(() => hardenTerminalInputForMobile(container)).not.toThrow();
    expect(container.children).toHaveLength(0);
  });
});
