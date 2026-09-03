import { clampTerminalSize } from '@omxterm/core/protocol';
import { xtermTheme } from '@omxterm/core/theme';
import type {
  TerminalStatus,
  TerminalTransportAdapter,
} from '@omxterm/core/terminal';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ClipboardWriteConsentSession } from './clipboard-write-consent';
import { hardenTerminalInputForMobile } from './harden-terminal-input-for-mobile';
import { keepTerminalFocused, TerminalKeyBar } from './TerminalKeyBar';
import { registerTerminalControlSequenceHandlers } from './terminal-control-sequences';
import { applyStickyCtrlModifier } from './terminal-key-sequences';
import {
  BASE_TERMINAL_FONT_SIZE,
  clampTerminalFontSize,
  nextTerminalFontSize,
} from './terminal-font-zoom';
import { attachTerminalPinchZoom } from './terminal-pinch-zoom';

// navigator.clipboard is only defined in a secure context (localhost and the
// https deploy qualify) and can still reject a user-approved write. Keep this
// mutation behind an async boundary so the UI can report that failure.
async function writeHostClipboard(text: string): Promise<void> {
  if (!navigator.clipboard) {
    throw new Error('Clipboard access is unavailable.');
  }
  await navigator.clipboard.writeText(text);
}

// xterm reads its font from the DOM when open() runs, so the Nerd Font must lead
// the stack and be loaded before that point — see loadTerminalFont.
const NERD_FONT_FAMILY = 'JetBrainsMono Nerd Font Mono';
const TERMINAL_FONT_FAMILY = `"${NERD_FONT_FAMILY}", Inconsolata, JetBrains Mono, SFMono-Regular, Menlo, Monaco, Consolas, monospace`;

// xterm measures cell metrics from the active font at open() and never re-measures
// when a webfont arrives later, which would misalign the grid. Wait for both
// weights so the first paint already uses the Nerd Font; fall back otherwise.
async function loadTerminalFont(fontSize: number): Promise<void> {
  if (!('fonts' in document)) return;
  try {
    await Promise.all([
      document.fonts.load(`${fontSize}px "${NERD_FONT_FAMILY}"`),
      document.fonts.load(`bold ${fontSize}px "${NERD_FONT_FAMILY}"`),
    ]);
  } catch {
    // Best-effort: the font stack still renders text without the Nerd Font.
  }
}

export function TerminalEmulator({
  adapter,
  title,
  onDisconnect,
}: {
  adapter: TerminalTransportAdapter;
  title: string;
  onDisconnect(): void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<TerminalStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [topbarVisible, setTopbarVisible] = useState(false);
  const [keyBarVisible, setKeyBarVisible] = useState(false);
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const [clipboardWritesEnabled, setClipboardWritesEnabled] = useState(false);
  const [pendingClipboardWrite, setPendingClipboardWrite] = useState<
    string | null
  >(null);
  const [clipboardError, setClipboardError] = useState<string | null>(null);
  // OSC handlers are installed once for the terminal session. This object lets
  // that long-lived parser callback enforce the latest consent state without
  // rebuilding xterm whenever a prompt opens or closes.
  const clipboardConsentRef = useRef(new ClipboardWriteConsentSession());
  // terminal.onData is wired once per adapter (see the effect below), so it
  // needs a ref rather than the `ctrlArmed` state value to see the latest
  // armed state without re-subscribing on every toggle.
  const ctrlArmedRef = useRef(false);
  const armCtrl = () => {
    ctrlArmedRef.current = !ctrlArmedRef.current;
    setCtrlArmed(ctrlArmedRef.current);
  };
  const sendKeyBarSequence = (sequence: string) => adapter.sendInput(sequence);
  // The key bar's zoom buttons live outside the effect that owns the terminal,
  // so the controls created in openTerminal are handed out through a ref (#120).
  const fontZoomRef = useRef<{
    adjustBy(delta: number): void;
    reset(): void;
  } | null>(null);

  const clearPendingClipboardWrite = useCallback(() => {
    clipboardConsentRef.current.reject();
    setPendingClipboardWrite(null);
  }, []);

  const disableClipboardWrites = useCallback(() => {
    clipboardConsentRef.current.disable();
    setClipboardWritesEnabled(false);
    setPendingClipboardWrite(null);
  }, []);

  const requestClipboardWrite = useCallback((text: string) => {
    // Disabled requests are discarded at arrival and can never become pending
    // after a later opt-in. A second request cannot replace the text currently
    // being reviewed either; every displayed decision remains unambiguous.
    if (!clipboardConsentRef.current.request(text)) return;
    setClipboardError(null);
    setPendingClipboardWrite(text);
  }, []);

  const toggleClipboardWrites = () => {
    const enabled = !clipboardConsentRef.current.enabled;
    if (enabled && status !== 'connected') return;
    if (enabled) {
      clipboardConsentRef.current.enable();
    } else {
      clipboardConsentRef.current.disable();
    }
    setClipboardWritesEnabled(enabled);
    setClipboardError(null);
    if (!enabled) clearPendingClipboardWrite();
  };

  const acceptClipboardWrite = () => {
    // Consent is one-shot: clear the request before crossing the browser
    // clipboard boundary, including when the asynchronous mutation fails.
    const accepted = clipboardConsentRef.current.accept(writeHostClipboard);
    setPendingClipboardWrite(null);
    void accepted.catch(() => {
      setClipboardError('The browser could not write to your clipboard.');
    });
  };

  useEffect(() => {
    if (!containerRef.current) return;

    // A new adapter is a new terminal session. Consent never follows it.
    disableClipboardWrites();
    setClipboardError(null);

    const openTerminal = (container: HTMLDivElement) => {
      const terminal = new Terminal({
        cursorBlink: true,
        scrollback: 2000,
        convertEol: false,
        // Unicode11Addon activates xterm's proposed unicode API, so it must be on.
        allowProposedApi: true,
        minimumContrastRatio: 4.5,
        fontFamily: TERMINAL_FONT_FAMILY,
        fontSize: BASE_TERMINAL_FONT_SIZE,
        lineHeight: 1.2,
        theme: xtermTheme,
      });
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);

      // web-links makes URLs clickable; unicode11 fixes emoji/CJK cell width so
      // wide glyphs no longer break grid alignment.
      terminal.loadAddon(new WebLinksAddon());
      terminal.loadAddon(new Unicode11Addon());
      terminal.unicode.activeVersion = '11';

      const controlSequenceHandlers = registerTerminalControlSequenceHandlers(
        terminal,
        requestClipboardWrite,
      );

      terminal.open(container);
      // Mobile browsers apply autocorrect/spellcheck to xterm's hidden input
      // textarea as if it were a normal text field, corrupting shell input
      // (#21) — the helper textarea only exists once open() has run.
      hardenTerminalInputForMobile(container);

      // Keep both xterm's grid and the server PTY aligned with the rendered size.
      // A very large container can fit past the shared resize bounds, so clamp
      // the fitted size and force xterm back onto the clamped grid before
      // sending it — otherwise the broker rejects the resize and xterm keeps
      // rendering against a PTY that stays at its previous size (#80).
      const syncTerminalSize = () => {
        fitAddon.fit();
        const { cols, rows } = clampTerminalSize(terminal.cols, terminal.rows);
        if (cols !== terminal.cols || rows !== terminal.rows) {
          terminal.resize(cols, rows);
        }
        adapter.resize(cols, rows);
      };

      // Every zoom entry point (keyboard, pinch, key bar buttons) funnels
      // through the same clamp + resize flow so the grid and PTY never drift.
      const currentFontSize = () =>
        terminal.options.fontSize ?? BASE_TERMINAL_FONT_SIZE;
      const applyFontSize = (next: number) => {
        if (next === currentFontSize()) return;
        terminal.options.fontSize = next;
        requestAnimationFrame(syncTerminalSize);
      };

      // Cmd-only zoom: Ctrl is left to the terminal so we never shadow readline
      // shortcuts (e.g. Ctrl+_ undo). preventDefault stops the browser page zoom.
      terminal.attachCustomKeyEventHandler(event => {
        if (event.type !== 'keydown') return true;
        const fontSize = nextTerminalFontSize(currentFontSize(), {
          withZoomModifier: event.metaKey,
          key: event.key,
        });
        if (fontSize === null) return true;

        event.preventDefault();
        applyFontSize(fontSize);
        return false;
      });

      // Touch devices have no Cmd modifier, so pinch and the key bar's
      // A− / A / A+ buttons cover zoom there (#120).
      const detachPinchZoom = attachTerminalPinchZoom(container, {
        currentFontSize,
        applyFontSize,
      });
      fontZoomRef.current = {
        adjustBy: delta =>
          applyFontSize(clampTerminalFontSize(currentFontSize() + delta)),
        reset: () => applyFontSize(BASE_TERMINAL_FONT_SIZE),
      };

      const disposables = [
        adapter.onOutput((data, consumed) => terminal.write(data, consumed)),
        adapter.onStatusChange(next => {
          setStatus(next);
          if (next === 'closing' || next === 'closed' || next === 'error') {
            disableClipboardWrites();
          }
          // The PTY only exists once the server reports "connected", and the
          // resize sent before the socket opened was dropped by the transport.
          // Re-sync here so the PTY starts at the real fitted size, not 80x24.
          if (next === 'connected') syncTerminalSize();
        }),
        adapter.onError(setError),
      ];
      // The key bar's sticky Ctrl modifier arms here rather than in
      // attachCustomKeyEventHandler because it must also catch letters typed
      // on a mobile soft keyboard, which never dispatch real KeyboardEvents.
      const inputDisposable = terminal.onData(data => {
        const wasArmed = ctrlArmedRef.current;
        const { armed, output } = applyStickyCtrlModifier(data, wasArmed);
        ctrlArmedRef.current = armed;
        // Only touch React state on the disarm transition — every other
        // keystroke would otherwise force a re-render for no visible change.
        if (wasArmed) setCtrlArmed(armed);
        adapter.sendInput(output);
      });
      const resizeObserver = new ResizeObserver(() => syncTerminalSize());
      resizeObserver.observe(container);

      requestAnimationFrame(() => {
        syncTerminalSize();
        void adapter
          .connect()
          .catch(caught =>
            setError(
              caught instanceof Error ? caught.message : 'Connection failed.',
            ),
          );
      });

      return () => {
        disableClipboardWrites();
        fontZoomRef.current = null;
        detachPinchZoom();
        resizeObserver.disconnect();
        inputDisposable.dispose();
        controlSequenceHandlers.dispose();
        disposables.forEach(dispose => dispose());
        adapter.close();
        terminal.dispose();
      };
    };

    let disposed = false;
    let disposeTerminal: (() => void) | null = null;

    // Gate open() on the Nerd Font so xterm's first cell measurement uses it.
    void loadTerminalFont(BASE_TERMINAL_FONT_SIZE).then(() => {
      const container = containerRef.current;
      if (disposed || !container) return;
      disposeTerminal = openTerminal(container);
    });

    return () => {
      disposed = true;
      disposeTerminal?.();
    };
  }, [adapter, disableClipboardWrites, requestClipboardWrite]);

  return (
    <section className='terminal-stage' aria-label='Terminal session'>
      {topbarVisible ? (
        <header className='terminal-topbar'>
          <h1>{title}</h1>
          <div className='terminal-actions'>
            <span className={`status-pill status-${status}`}>{status}</span>
            <button
              type='button'
              className='ghost-button'
              aria-pressed={clipboardWritesEnabled}
              disabled={status !== 'connected' && !clipboardWritesEnabled}
              onClick={toggleClipboardWrites}
            >
              {clipboardWritesEnabled
                ? 'Disable remote clipboard writes'
                : 'Enable remote clipboard writes'}
            </button>
            <button
              type='button'
              className='ghost-button'
              onClick={() => setTopbarVisible(false)}
            >
              Hide bar
            </button>
            <button
              type='button'
              className='ghost-button'
              onClick={onDisconnect}
            >
              End session
            </button>
          </div>
        </header>
      ) : (
        <button
          type='button'
          className='ghost-button show-topbar'
          onClick={() => setTopbarVisible(true)}
          aria-label='Show toolbar (+)'
        >
          +
        </button>
      )}
      {error ? (
        <div className='inline-error' role='alert'>
          {error}
        </div>
      ) : null}
      {clipboardError ? (
        <div className='inline-error' role='alert'>
          {clipboardError}
        </div>
      ) : null}
      <div ref={containerRef} className='terminal-surface' />
      {pendingClipboardWrite !== null ? (
        <div
          className='clipboard-consent-backdrop'
          role='dialog'
          aria-modal='true'
          aria-labelledby='clipboard-consent-title'
          aria-describedby='clipboard-consent-description'
          onKeyDown={event => {
            if (event.key === 'Escape') clearPendingClipboardWrite();
          }}
        >
          <div className='clipboard-consent-dialog'>
            <h2 id='clipboard-consent-title'>Remote clipboard write</h2>
            <p id='clipboard-consent-description'>
              The remote session wants to copy this decoded text to your
              clipboard. Review it before allowing the write.
            </p>
            <pre aria-label='Decoded clipboard text'>
              {pendingClipboardWrite}
            </pre>
            <div className='button-row'>
              <button
                type='button'
                className='ghost-button'
                autoFocus
                onClick={clearPendingClipboardWrite}
              >
                Reject
              </button>
              <button type='button' onClick={acceptClipboardWrite}>
                Copy to clipboard
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {keyBarVisible ? (
        <TerminalKeyBar
          ctrlArmed={ctrlArmed}
          onToggleCtrl={armCtrl}
          onSendSequence={sendKeyBarSequence}
          onFontSizeDecrease={() => fontZoomRef.current?.adjustBy(-1)}
          onFontSizeReset={() => fontZoomRef.current?.reset()}
          onFontSizeIncrease={() => fontZoomRef.current?.adjustBy(1)}
          onHide={() => setKeyBarVisible(false)}
        />
      ) : (
        <button
          type='button'
          className='ghost-button show-key-bar'
          onMouseDown={keepTerminalFocused}
          onClick={() => setKeyBarVisible(true)}
          aria-label='Show keyboard tools (+)'
        >
          +
        </button>
      )}
    </section>
  );
}
