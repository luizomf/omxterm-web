import type {
  TerminalStatus,
  TerminalTransportAdapter,
} from '@omxterm/core/terminal';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';
import { TerminalEmulator } from './TerminalEmulator';

const { oscHandlers, writeText } = vi.hoisted(() => ({
  oscHandlers: new Map<number, (payload: string) => boolean>(),
  writeText: vi.fn(async () => undefined),
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = { fontSize: 16 };
    unicode = { activeVersion: '' };
    parser = {
      registerOscHandler: (
        identifier: number,
        handler: (payload: string) => boolean,
      ) => {
        oscHandlers.set(identifier, handler);
        return { dispose: () => oscHandlers.delete(identifier) };
      },
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
Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: { writeText },
});

afterEach(() => {
  cleanup();
  oscHandlers.clear();
  writeText.mockClear();
  writeText.mockResolvedValue(undefined);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

type TestAdapter = TerminalTransportAdapter & {
  emitStatus(status: TerminalStatus): void;
};

function createAdapter(): TestAdapter {
  const statusHandlers = new Set<(status: TerminalStatus) => void>();
  return {
    connect: vi.fn(async () => undefined),
    sendInput: vi.fn(),
    resize: vi.fn(),
    close: vi.fn(),
    onOutput: vi.fn(() => vi.fn()),
    onStatusChange: vi.fn((handler: (status: TerminalStatus) => void) => {
      statusHandlers.add(handler);
      return () => statusHandlers.delete(handler);
    }),
    onError: vi.fn(() => vi.fn()),
    emitStatus: (status: TerminalStatus) =>
      statusHandlers.forEach(handler => handler(status)),
  };
}

async function getOsc52Handler() {
  await waitFor(() => expect(oscHandlers.get(52)).toBeDefined());
  return oscHandlers.get(52)!;
}

function showClipboardControl() {
  fireEvent.click(screen.getByRole('button', { name: 'Show toolbar (+)' }));
  return screen.getByRole('button', {
    name: 'Enable remote clipboard writes',
  });
}

function enableClipboardWrites(adapter: TestAdapter) {
  act(() => adapter.emitStatus('connected'));
  const enableButton = showClipboardControl();
  expect(enableButton).toHaveAttribute('aria-pressed', 'false');
  fireEvent.click(enableButton);
  expect(
    screen.getByRole('button', { name: 'Disable remote clipboard writes' }),
  ).toHaveAttribute('aria-pressed', 'true');
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

describe('TerminalEmulator OSC 52 consent', () => {
  test('starts disabled and does not queue requests received before opt-in', async () => {
    const adapter = createAdapter();
    render(
      <TerminalEmulator
        adapter={adapter}
        title='demo@example.test'
        onDisconnect={vi.fn()}
      />,
    );
    const handleOsc52 = await getOsc52Handler();
    act(() => adapter.emitStatus('connected'));

    act(() => handleOsc52('c;ZGlzYWJsZWQ='));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    enableClipboardWrites(adapter);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(writeText).not.toHaveBeenCalled();
  });

  test('shows decoded text and writes only after one-shot acceptance', async () => {
    const adapter = createAdapter();
    render(
      <TerminalEmulator
        adapter={adapter}
        title='demo@example.test'
        onDisconnect={vi.fn()}
      />,
    );
    const handleOsc52 = await getOsc52Handler();
    enableClipboardWrites(adapter);

    act(() => handleOsc52('c;b2zDoSDwn4yO'));

    expect(
      screen.getByRole('dialog', { name: 'Remote clipboard write' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Decoded clipboard text')).toHaveTextContent(
      'olá 🌎',
    );
    act(() => handleOsc52('c;ZXZpbA=='));
    expect(screen.getByLabelText('Decoded clipboard text')).not.toHaveTextContent(
      'evil',
    );
    expect(writeText).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith('olá 🌎');
  });

  test('rejects before mutation and clears the request', async () => {
    const adapter = createAdapter();
    render(
      <TerminalEmulator
        adapter={adapter}
        title='demo@example.test'
        onDisconnect={vi.fn()}
      />,
    );
    const handleOsc52 = await getOsc52Handler();
    enableClipboardWrites(adapter);

    act(() => handleOsc52('c;cmVqZWN0IG1l'));
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(writeText).not.toHaveBeenCalled();

    act(() => handleOsc52('c;bmV4dA=='));
    expect(screen.getByLabelText('Decoded clipboard text')).toHaveTextContent(
      'next',
    );
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(writeText).not.toHaveBeenCalled();
  });

  test('never prompts for read or oversized payloads after opt-in', async () => {
    const adapter = createAdapter();
    render(
      <TerminalEmulator
        adapter={adapter}
        title='demo@example.test'
        onDisconnect={vi.fn()}
      />,
    );
    const handleOsc52 = await getOsc52Handler();
    enableClipboardWrites(adapter);

    act(() => {
      handleOsc52('c;?');
      handleOsc52(`c;${btoa('a'.repeat(64 * 1024 + 1))}`);
    });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(writeText).not.toHaveBeenCalled();
  });

  test('ends consent and dismisses pending text when the session closes', async () => {
    const adapter = createAdapter();
    render(
      <TerminalEmulator
        adapter={adapter}
        title='demo@example.test'
        onDisconnect={vi.fn()}
      />,
    );
    const handleOsc52 = await getOsc52Handler();
    enableClipboardWrites(adapter);
    act(() => handleOsc52('c;cGVuZGluZw=='));

    act(() => adapter.emitStatus('closed'));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Enable remote clipboard writes' }),
    ).toBeDisabled();
    act(() => handleOsc52('c;YWZ0ZXIgY2xvc2U='));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(writeText).not.toHaveBeenCalled();
  });

  test('reports an accepted browser clipboard failure after clearing consent', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'));
    const adapter = createAdapter();
    render(
      <TerminalEmulator
        adapter={adapter}
        title='demo@example.test'
        onDisconnect={vi.fn()}
      />,
    );
    const handleOsc52 = await getOsc52Handler();
    enableClipboardWrites(adapter);
    act(() => handleOsc52('c;ZmFpbA=='));

    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The browser could not write to your clipboard.',
    );
  });
});
