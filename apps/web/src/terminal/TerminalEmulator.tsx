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
import {
  BASE_TERMINAL_FONT_SIZE,
  nextTerminalFontSize,
} from './terminal-font-zoom';

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

      terminal.open(container);

      // Keep both xterm's grid and the server PTY aligned with the rendered size.
      const syncTerminalSize = () => {
        fitAddon.fit();
        adapter.resize(terminal.cols, terminal.rows);
      };

      // Cmd-only zoom: Ctrl is left to the terminal so we never shadow readline
      // shortcuts (e.g. Ctrl+_ undo). preventDefault stops the browser page zoom.
      terminal.attachCustomKeyEventHandler(event => {
        if (event.type !== 'keydown') return true;
        const fontSize = nextTerminalFontSize(
          terminal.options.fontSize ?? BASE_TERMINAL_FONT_SIZE,
          {
            withZoomModifier: event.metaKey,
            key: event.key,
          },
        );
        if (fontSize === null) return true;

        event.preventDefault();
        terminal.options.fontSize = fontSize;
        requestAnimationFrame(syncTerminalSize);
        return false;
      });

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
      const inputDisposable = terminal.onData(data => adapter.sendInput(data));
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
        resizeObserver.disconnect();
        inputDisposable.dispose();
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
      <header className='terminal-topbar'>
        <h1>{title}</h1>
        <div className='terminal-actions'>
          <span className={`status-pill status-${status}`}>{status}</span>
          <button type='button' className='ghost-button' onClick={onDisconnect}>
            End session
          </button>
        </div>
      </header>
      {error ? (
        <div className='inline-error' role='alert'>
          {error}
        </div>
      ) : null}
      <div ref={containerRef} className='terminal-surface' />
    </section>
  );
}
