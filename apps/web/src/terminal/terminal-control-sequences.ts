import type { IDisposable, Terminal } from '@xterm/xterm';
import { handleOsc52, type HostClipboardWriter } from './osc52-clipboard';

/**
 * Registers the remote-controlled OSC handlers owned by OMXTerm Web.
 *
 * xterm core handles OSC 8 even without WebLinksAddon and retains each URI for
 * as long as linked cells remain in scrollback. The MVP does not need semantic
 * hyperlinks, so the last-registered handler consumes OSC 8 before xterm's core
 * handler can retain attacker-controlled URIs. WebLinksAddon remains installed
 * separately and still detects ordinary visible http(s) URLs.
 */
export function registerTerminalControlSequenceHandlers(
  terminal: Terminal,
  writeClipboard: HostClipboardWriter,
): IDisposable {
  const osc8Disposable = terminal.parser.registerOscHandler(8, () => true);
  const osc52Disposable = terminal.parser.registerOscHandler(52, payload =>
    handleOsc52(payload, writeClipboard),
  );

  return {
    dispose(): void {
      osc52Disposable.dispose();
      osc8Disposable.dispose();
    },
  };
}
