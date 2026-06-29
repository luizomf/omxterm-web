// OSC 52 lets programs inside the SSH session (tmux, nvim) copy text into the
// host clipboard. We support WRITE only and intentionally ignore READ requests:
// answering a read would let the remote host exfiltrate the local clipboard,
// which is the security boundary called out in issue #16. This module keeps the
// decoding/routing decision pure so it can be tested without a live terminal.

/** Writes decoded text into the host clipboard. Injected at the boundary. */
export type HostClipboardWriter = (text: string) => void;

function decodeBase64Utf8(encoded: string): string | null {
  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    // OSC 52 payloads come from the remote host, so malformed base64 is
    // expected input, not a bug — swallow it instead of throwing into xterm.
    return null;
  }
}

/**
 * Handles an OSC 52 payload (`Pc ; Pd`, e.g. `c;SGVsbG8=`). Decodes the base64
 * write payload and forwards it to the clipboard. Read requests (`Pd === '?'`)
 * and empty payloads are ignored so the host can never read or clear the
 * clipboard. Always returns true to mark the sequence as fully handled.
 *
 * @example
 * handleOsc52('c;SGVsbG8=', writeClipboard); // writes "Hello", returns true
 * handleOsc52('c;?', writeClipboard);         // ignored (read), returns true
 */
export function handleOsc52(
  payload: string,
  writeClipboard: HostClipboardWriter,
): boolean {
  const separator = payload.indexOf(';');
  if (separator === -1) return true;

  const data = payload.slice(separator + 1);
  if (data === '' || data === '?') return true;

  const text = decodeBase64Utf8(data);
  if (text === null) return true;

  writeClipboard(text);
  return true;
}
