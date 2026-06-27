import { xtermTheme } from '@omxterm/core/theme';
import type { TerminalStatus, TerminalTransportAdapter } from '@omxterm/core/terminal';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';

export function TerminalEmulator({ adapter, title, onDisconnect }: { adapter: TerminalTransportAdapter; title: string; onDisconnect(): void }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<TerminalStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const terminal = new Terminal({
      cursorBlink: true,
      scrollback: 2000,
      convertEol: false,
      allowProposedApi: false,
      minimumContrastRatio: 4.5,
      fontFamily: 'JetBrains Mono, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 14,
      lineHeight: 1.25,
      theme: xtermTheme,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);

    const disposables = [
      adapter.onOutput((data) => terminal.write(data)),
      adapter.onStatusChange(setStatus),
      adapter.onError(setError),
    ];
    const inputDisposable = terminal.onData((data) => adapter.sendInput(data));
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      adapter.resize(terminal.cols, terminal.rows);
    });
    resizeObserver.observe(container);

    requestAnimationFrame(() => {
      fitAddon.fit();
      adapter.resize(terminal.cols, terminal.rows);
      void adapter.connect().catch((caught) => setError(caught instanceof Error ? caught.message : 'Connection failed.'));
    });

    return () => {
      resizeObserver.disconnect();
      inputDisposable.dispose();
      disposables.forEach((dispose) => dispose());
      adapter.close();
      terminal.dispose();
    };
  }, [adapter]);

  return (
    <section className="terminal-stage" aria-label="Terminal session">
      <header className="terminal-topbar">
        <div>
          <p className="eyebrow">OMXTerm</p>
          <h1>{title}</h1>
        </div>
        <div className="terminal-actions">
          <span className={`status-pill status-${status}`}>{status}</span>
          <button type="button" className="ghost-button" onClick={onDisconnect}>End session</button>
        </div>
      </header>
      {error ? <div className="inline-error" role="alert">{error}</div> : null}
      <div ref={containerRef} className="terminal-surface" />
    </section>
  );
}
