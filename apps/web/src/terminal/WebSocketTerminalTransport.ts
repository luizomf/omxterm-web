import type { ServerMessage } from '@omxterm/core/protocol';
import type { TerminalStatus, TerminalTransportAdapter, Unsubscribe } from '@omxterm/core/terminal';

type Handler<T> = (value: T) => void;

export class WebSocketTerminalTransport implements TerminalTransportAdapter {
  #socket: WebSocket | null = null;
  readonly #outputHandlers = new Set<Handler<string>>();
  readonly #statusHandlers = new Set<Handler<TerminalStatus>>();
  readonly #errorHandlers = new Set<Handler<string>>();

  constructor(private readonly url: string) {}

  connect(): Promise<void> {
    this.#setStatus('connecting');
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.#socket = socket;

      socket.addEventListener('open', () => resolve());
      socket.addEventListener('message', (event) => this.#handleMessage(event.data));
      socket.addEventListener('close', () => this.#setStatus('closed'));
      socket.addEventListener('error', () => {
        this.#setStatus('error');
        this.#emitError('WebSocket connection failed.');
        reject(new Error('WebSocket connection failed.'));
      }, { once: true });
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

  onOutput(handler: Handler<string>): Unsubscribe {
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

  #send(payload: unknown): void {
    if (this.#socket?.readyState !== WebSocket.OPEN) return;
    this.#socket.send(JSON.stringify(payload));
  }

  #handleMessage(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let message: ServerMessage;
    try {
      message = JSON.parse(raw) as ServerMessage;
    } catch {
      this.#emitError('Received invalid terminal message.');
      return;
    }

    if (message.type === 'ready') this.#setStatus('connected');
    if (message.type === 'output') this.#outputHandlers.forEach((handler) => handler(message.data));
    if (message.type === 'error') {
      this.#setStatus('error');
      this.#emitError(message.message);
    }
    if (message.type === 'exit') this.#setStatus('closed');
  }

  #setStatus(status: TerminalStatus): void {
    this.#statusHandlers.forEach((handler) => handler(status));
  }

  #emitError(message: string): void {
    this.#errorHandlers.forEach((handler) => handler(message));
  }
}
