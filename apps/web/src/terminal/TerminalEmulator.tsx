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
import { useEffect, useRef, useState } from 'react';
import { hardenTerminalInputForMobile } from './harden-terminal-input-for-mobile';
import { handleOsc52 } from './osc52-clipboard';
import { TerminalKeyBar } from './TerminalKeyBar';
import { applyStickyCtrlModifier } from './terminal-key-sequences';
import {
  BASE_TERMINAL_FONT_SIZE,
  clampTerminalFontSize,
  nextTerminalFontSize,
} from './terminal-font-zoom';
import { attachTerminalPinchZoom } from './terminal-pinch-zoom';

// Best-effort host clipboard write for OSC 52. navigator.clipboard is only
// defined in a secure context (localhost and the https deploy qualify) and can
// reject without a user gesture; OSC 52 copy is non-critical, so we swallow.
function writeHostClipboard(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => {});
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
  const [topbarVisible, setTopbarVisible] = useState(true);
  const [ctrlArmed, setCtrlArmed] = useState(false);
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

  useEffect(() => {
    if (!containerRef.current) return;

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

      // xterm has no built-in OSC 52, so tmux/nvim yanks reach the host
      // clipboard only if we register it. Write-only by design — see handleOsc52.
      const osc52Disposable = terminal.parser.registerOscHandler(52, payload =>
        handleOsc52(payload, writeHostClipboard),
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
        adapter.onOutput(data => terminal.write(data)),
        adapter.onStatusChange(next => {
          setStatus(next);
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
        fontZoomRef.current = null;
        detachPinchZoom();
        resizeObserver.disconnect();
        inputDisposable.dispose();
        osc52Disposable.dispose();
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
  }, [adapter]);

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
      <div ref={containerRef} className='terminal-surface' />
      <TerminalKeyBar
        ctrlArmed={ctrlArmed}
        onToggleCtrl={armCtrl}
        onSendSequence={sendKeyBarSequence}
        onFontSizeDecrease={() => fontZoomRef.current?.adjustBy(-1)}
        onFontSizeReset={() => fontZoomRef.current?.reset()}
        onFontSizeIncrease={() => fontZoomRef.current?.adjustBy(1)}
      />
    </section>
  );
}
