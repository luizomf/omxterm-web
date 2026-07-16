import type { TerminalTransportAdapter } from '@omxterm/core/terminal';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';
import { TerminalEmulator } from './TerminalEmulator';

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = { fontSize: 16 };
    unicode = { activeVersion: '' };
    parser = {
      registerOscHandler: () => ({ dispose: vi.fn() }),
    };

    loadAddon(): void {}
    open(): void {}
    attachCustomKeyEventHandler(): void {}
    onData() {
      return { dispose: vi.fn() };
    }
    resize(): void {}
    write(): void {}
    dispose(): void {}
  },
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
  },
}));

vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    disconnect(): void {}
  },
);
vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
  callback(0);
  return 1;
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function createAdapter(): TerminalTransportAdapter {
  return {
    connect: vi.fn(async () => undefined),
    sendInput: vi.fn(),
    resize: vi.fn(),
    close: vi.fn(),
    onOutput: vi.fn(() => vi.fn()),
    onStatusChange: vi.fn(() => vi.fn()),
    onError: vi.fn(() => vi.fn()),
  };
}

describe('TerminalEmulator chrome visibility', () => {
  test('starts both bars hidden and lets each bar be shown and hidden again', () => {
    render(
      <TerminalEmulator
        adapter={createAdapter()}
        title='demo@example.test'
        onDisconnect={vi.fn()}
      />,
    );

    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('toolbar', { name: 'Terminal key shortcuts' }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show toolbar (+)' }));
    expect(screen.getByRole('heading')).toHaveTextContent('demo@example.test');
    fireEvent.click(screen.getByRole('button', { name: 'Hide bar' }));
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'Show keyboard tools (+)' }),
    );
    expect(
      screen.getByRole('toolbar', { name: 'Terminal key shortcuts' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hide tools' }));
    expect(
      screen.queryByRole('toolbar', { name: 'Terminal key shortcuts' }),
    ).not.toBeInTheDocument();
  });
});
