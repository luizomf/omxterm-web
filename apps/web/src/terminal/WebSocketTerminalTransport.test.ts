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
  readonly #listeners = new Map<SocketEvent, SocketListener[]>();

  addEventListener(type: SocketEvent, listener: SocketListener): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  send(): void {}

  close(): void {
    this.closeCount += 1;
  }

  emit(type: SocketEvent, event: { data: unknown } = { data: undefined }): void {
    this.#listeners.get(type)?.forEach(listener => listener(event));
  }
}

function createTransport(): {
  transport: WebSocketTerminalTransport;
  socket: FakeSocket;
  statuses: TerminalStatus[];
} {
  const socket = new FakeSocket();
  const transport = new WebSocketTerminalTransport('ws://test/terminal/ws', {
    createSocket: () => socket,
  });
  const statuses: TerminalStatus[] = [];
  transport.onStatusChange(status => statuses.push(status));
  return { transport, socket, statuses };
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
