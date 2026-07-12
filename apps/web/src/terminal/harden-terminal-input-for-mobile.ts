// xterm.js drives real input through a visually-hidden `<textarea>` it creates
// on open() (`.xterm-helper-textarea`). Mobile browsers treat that textarea
// like an ordinary text field: they autocorrect/autocapitalize keystrokes and
// spellcheck-underline them before xterm ever reads them, which corrupts shell
// input (e.g. "ls" becoming "Ls", or a suggestion popup stealing a keystroke).
// Hardening these attributes keeps mobile typing raw (#21).
export function hardenTerminalInputForMobile(container: HTMLElement): void {
  const helperTextarea = container.querySelector<HTMLTextAreaElement>(
    '.xterm-helper-textarea',
  );
  if (!helperTextarea) return;

  helperTextarea.setAttribute('autocomplete', 'off');
  helperTextarea.setAttribute('autocorrect', 'off');
  helperTextarea.setAttribute('autocapitalize', 'off');
  helperTextarea.spellcheck = false;
  // Explicit "text" (rather than leaving it unset) so mobile keyboards don't
  // infer a specialized layout/suggestion behavior from context.
  helperTextarea.setAttribute('inputmode', 'text');
}
