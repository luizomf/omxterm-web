import type { TerminalStatus } from '@omxterm/core/terminal';
import { describe, expect, test } from 'vitest';
import {
  WebSocketTerminalTransport,
  type TerminalSocket,
} from './WebSocketTerminalTransport';

type SocketEvent = 'open' | 'message' | 'close' | 'error';
type SocketListener = (event: { data: unknown }) => void;

// A minimal stand-in for the browser WebSocket so connect() lifecycle can be
// driven deterministically without a real network socket (#76).
class FakeSocket implements TerminalSocket {
  readyState = 0;
  closeCount = 0;
  readonly sent: string[] = [];
  closeCode: number | undefined;
  readonly #listeners = new Map<SocketEvent, SocketListener[]>();

  addEventListener(type: SocketEvent, listener: SocketListener): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    this.closeCount += 1;
    this.closeCode = code;
  }

  emit(type: SocketEvent, event: { data: unknown } = { data: undefined }): void {
    if (type === 'open') this.readyState = 1;
    if (type === 'close') this.readyState = 3;
    this.#listeners.get(type)?.forEach(listener => listener(event));
  }
}

function createTransport(): {
  transport: WebSocketTerminalTransport;
  socket: FakeSocket;
  statuses: TerminalStatus[];
  errors: string[];
} {
  const socket = new FakeSocket();
  const transport = new WebSocketTerminalTransport('ws://test/terminal/ws', {
    createSocket: () => socket,
  });
  const statuses: TerminalStatus[] = [];
  const errors: string[] = [];
  transport.onStatusChange(status => statuses.push(status));
  transport.onError(message => errors.push(message));
  return { transport, socket, statuses, errors };
}

function serverMessage(socket: FakeSocket, message: unknown): void {
  socket.emit('message', { data: JSON.stringify(message) });
}

describe('WebSocketTerminalTransport.connect', () => {
  test('rejects when the socket closes before it opens', async () => {
    const { transport, socket, statuses } = createTransport();

    const connecting = transport.connect();
    socket.emit('close');

    await expect(connecting).rejects.toThrow();
    expect(statuses).toContain('closed');
  });

  test('rejects when the socket errors before it opens', async () => {
    const { transport, socket, statuses } = createTransport();

    const connecting = transport.connect();
    socket.emit('error');

    await expect(connecting).rejects.toThrow();
    expect(statuses).toContain('error');
  });

  test('resolves when the socket opens', async () => {
    const { transport, socket } = createTransport();

    const connecting = transport.connect();
    socket.emit('open');

    await expect(connecting).resolves.toBeUndefined();
  });

  test('stays resolved and reports closed when the socket closes after opening', async () => {
    const { transport, socket, statuses } = createTransport();

    const connecting = transport.connect();
    socket.emit('open');
    await expect(connecting).resolves.toBeUndefined();

    socket.emit('close');
    expect(statuses).toContain('closed');
  });
});

describe('WebSocketTerminalTransport server error handling', () => {
  test('keeps the session connected when a resize is rejected', async () => {
    const { transport, socket, statuses, errors } = createTransport();

    const connecting = transport.connect();
    socket.emit('open');
    await connecting;
    serverMessage(socket, { type: 'ready', sessionId: 's1' });

    serverMessage(socket, {
      type: 'error',
      code: 'resize_out_of_bounds',
      message: 'Resize dimensions are outside the allowed bounds.',
    });

    // A rejected resize is a scoped control error: the PTY keeps its last good
    // size, so the transport must not fail the whole session (#80).
    expect(statuses).not.toContain('error');
    expect(statuses.at(-1)).toBe('connected');
    // The rejection is still observable, not swallowed.
    expect(errors).toContain('Resize dimensions are outside the allowed bounds.');
  });

  test('fails the transport on a non-resize server error', async () => {
    const { transport, socket, statuses } = createTransport();

    const connecting = transport.connect();
    socket.emit('open');
    await connecting;
    serverMessage(socket, { type: 'ready', sessionId: 's1' });

    serverMessage(socket, {
      type: 'error',
      code: 'ssh_error',
      message: 'The SSH session failed.',
    });

    expect(statuses).toContain('error');
  });
});

describe('WebSocketTerminalTransport output credit', () => {
  test('acknowledges UTF-8 bytes only after parser completion', async () => {
    const { transport, socket } = createTransport();
    let consumed: (() => void) | undefined;
    const output: string[] = [];
    transport.onOutput((data, complete) => {
      output.push(data);
      consumed = complete;
    });
    const connecting = transport.connect();
    socket.emit('open');
    await connecting;

    serverMessage(socket, { type: 'output', id: 1, data: 'olá 🌎', bytes: 9 });

    expect(output).toEqual(['olá 🌎']);
    expect(socket.sent).toEqual([]);
    consumed?.();
    expect(socket.sent.map(value => JSON.parse(value))).toEqual([
      { type: 'output_ack', id: 1, bytes: 9 },
    ]);
    consumed?.();
    expect(socket.sent).toHaveLength(1);
  });

  test('supports a synchronous parser completion callback', async () => {
    const { transport, socket } = createTransport();
    transport.onOutput((_data, complete) => complete());
    const connecting = transport.connect();
    socket.emit('open');
    await connecting;

    serverMessage(socket, { type: 'output', id: 1, data: 'ok', bytes: 2 });

    expect(JSON.parse(socket.sent[0] as string)).toEqual({
      type: 'output_ack',
      id: 1,
      bytes: 2,
    });
  });

  test.each([
    { type: 'output', id: 2, data: 'skip', bytes: 4 },
    { type: 'output', id: 1, data: '🌎', bytes: 1 },
    {
      type: 'output',
      id: 1,
      data: 'x'.repeat(32 * 1024 + 1),
      bytes: 32 * 1024 + 1,
    },
  ])('rejects invalid or out-of-order output: %o', async message => {
    const { transport, socket, errors } = createTransport();
    transport.onOutput((_data, complete) => complete());
    const connecting = transport.connect();
    socket.emit('open');
    await connecting;

    serverMessage(socket, message);

    expect(errors).toContain('Received invalid terminal output.');
    expect(socket.closeCode).toBe(1002);
    expect(socket.sent).toEqual([]);
  });

  test('does not send a late ACK after the socket closes', async () => {
    const { transport, socket } = createTransport();
    let consumed: (() => void) | undefined;
    transport.onOutput((_data, complete) => {
      consumed = complete;
    });
    const connecting = transport.connect();
    socket.emit('open');
    await connecting;
    serverMessage(socket, { type: 'output', id: 1, data: 'late', bytes: 4 });

    socket.emit('close');
    consumed?.();

    expect(socket.sent).toEqual([]);
  });
});
