import {
  MAX_TERMINAL_OUTPUT_CHUNK_BYTES,
  type ServerMessage,
} from '@omxterm/core/protocol';
import type {
  OutputConsumed,
  TerminalStatus,
  TerminalTransportAdapter,
  Unsubscribe,
} from '@omxterm/core/terminal';

type Handler<T> = (value: T) => void;
type OutputHandler = (data: string, consumed: OutputConsumed) => void;

// The slice of the browser WebSocket this transport drives. Injecting a factory
// for it is the smallest seam that lets tests settle connect() deterministically
// across open/close/error orderings without a real socket (#76).
export type TerminalSocket = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close', listener: () => void): void;
  addEventListener(type: 'error', listener: () => void): void;
};

export type WebSocketTerminalTransportDeps = {
  createSocket?: (url: string) => TerminalSocket;
};

// Standard WebSocket.OPEN readyState. Named locally so the transport does not
// depend on the global WebSocket being defined when it only guards a send.
const SOCKET_OPEN = 1;

export class WebSocketTerminalTransport implements TerminalTransportAdapter {
  #socket: TerminalSocket | null = null;
  readonly #outputHandlers = new Set<OutputHandler>();
  readonly #statusHandlers = new Set<Handler<TerminalStatus>>();
  readonly #errorHandlers = new Set<Handler<string>>();
  readonly #createSocket: (url: string) => TerminalSocket;
  #expectedOutputId = 1;

  constructor(
    private readonly url: string,
    deps: WebSocketTerminalTransportDeps = {},
  ) {
    this.#createSocket = deps.createSocket ?? ((url) => new WebSocket(url));
  }

  connect(): Promise<void> {
    this.#setStatus('connecting');
    return new Promise((resolve, reject) => {
      const socket = this.#createSocket(this.url);
      this.#socket = socket;
      this.#expectedOutputId = 1;
      let settled = false;

      socket.addEventListener('open', () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      socket.addEventListener('message', (event) =>
        this.#handleMessage(socket, event.data),
      );
      socket.addEventListener('close', () => {
        this.#setStatus('closed');
        if (settled) return;
        settled = true;
        // A close before open means the upgrade was rejected or the dial
        // dropped; reject so the caller never awaits a socket that will never
        // open (#76). No reconnect/resume — the session is over.
        this.#emitError('WebSocket closed before it opened.');
        reject(new Error('WebSocket closed before it opened.'));
      });
      socket.addEventListener('error', () => {
        this.#setStatus('error');
        if (settled) return;
        settled = true;
        this.#emitError('WebSocket connection failed.');
        reject(new Error('WebSocket connection failed.'));
      });
    });
  }

  sendInput(data: string): void {
    this.#send({ type: 'input', data });
  }

  resize(cols: number, rows: number): void {
    this.#send({ type: 'resize', cols, rows });
  }

  close(): void {
    this.#setStatus('closing');
    this.#socket?.close(1000, 'user');
  }

  onOutput(handler: OutputHandler): Unsubscribe {
    this.#outputHandlers.add(handler);
    return () => this.#outputHandlers.delete(handler);
  }

  onStatusChange(handler: Handler<TerminalStatus>): Unsubscribe {
    this.#statusHandlers.add(handler);
    return () => this.#statusHandlers.delete(handler);
  }

  onError(handler: Handler<string>): Unsubscribe {
    this.#errorHandlers.add(handler);
    return () => this.#errorHandlers.delete(handler);
  }

  #send(payload: unknown, socket = this.#socket): void {
    if (socket?.readyState !== SOCKET_OPEN || socket !== this.#socket) return;
    socket.send(JSON.stringify(payload));
  }

  #handleMessage(socket: TerminalSocket, raw: unknown): void {
    if (typeof raw !== 'string') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.#emitError('Received invalid terminal message.');
      return;
    }
    if (!isRecord(parsed) || typeof parsed.type !== 'string') {
      this.#emitError('Received invalid terminal message.');
      return;
    }
    const message = parsed as ServerMessage;

    if (message.type === 'ready') this.#setStatus('connected');
    if (message.type === 'output') this.#handleOutput(socket, message);
    if (message.type === 'error') this.#handleServerError(message);
    if (message.type === 'exit') this.#setStatus('closed');
  }

  #handleOutput(
    socket: TerminalSocket,
    message: Extract<ServerMessage, { type: 'output' }>,
  ): void {
    if (
      !Number.isSafeInteger(message.id) ||
      message.id !== this.#expectedOutputId ||
      typeof message.data !== 'string' ||
      !Number.isSafeInteger(message.bytes) ||
      message.bytes < 1 ||
      message.bytes > MAX_TERMINAL_OUTPUT_CHUNK_BYTES ||
      utf8ByteLength(message.data) !== message.bytes
    ) {
      this.#emitError('Received invalid terminal output.');
      socket.close(1002, 'invalid_output');
      return;
    }
    this.#expectedOutputId += 1;

    const handlers = [...this.#outputHandlers];
    let remaining = handlers.length;
    for (const handler of handlers) {
      let completed = false;
      handler(message.data, () => {
        if (completed) return;
        completed = true;
        remaining -= 1;
        if (remaining === 0) {
          this.#send(
            { type: 'output_ack', id: message.id, bytes: message.bytes },
            socket,
          );
        }
      });
    }
  }

  // A rejected resize is a scoped control error: the PTY keeps its last good
  // size and the session stays usable, so it must not push the whole transport
  // to `error` the way a real SSH/transport failure does (#80). The frontend
  // clamps to the shared bounds, so this only reaches a non-conforming client;
  // the message is still surfaced (never swallowed), just without failing the
  // session.
  #handleServerError(message: Extract<ServerMessage, { type: 'error' }>): void {
    if (message.code !== 'resize_out_of_bounds') this.#setStatus('error');
    this.#emitError(message.message);
  }

  #setStatus(status: TerminalStatus): void {
    this.#statusHandlers.forEach((handler) => handler(status));
  }

  #emitError(message: string): void {
    this.#errorHandlers.forEach((handler) => handler(message));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
