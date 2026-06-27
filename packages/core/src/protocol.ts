export type ClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ping'; ts: number };

export type ServerMessage =
  | { type: 'ready'; sessionId: string }
  | { type: 'output'; data: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'exit'; reason: string }
  | { type: 'pong'; ts: number };

export type ParseClientMessageResult =
  | { ok: true; message: ClientMessage }
  | { ok: false; code: 'invalid_json' | 'invalid_message' | 'resize_out_of_bounds' | 'payload_too_large'; message: string };

export type TerminalProtocolCodec = {
  parseClientMessage(raw: string): ParseClientMessageResult;
  encodeServerMessage(message: ServerMessage): string;
};

const MAX_JSON_PAYLOAD_BYTES = 64 * 1024;
const MIN_COLS = 20;
const MAX_COLS = 240;
const MIN_ROWS = 5;
const MAX_ROWS = 100;

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value);
}

export function createJsonTerminalProtocolCodec(): TerminalProtocolCodec {
  return {
    parseClientMessage(raw) {
      if (byteLength(raw) > MAX_JSON_PAYLOAD_BYTES) {
        return { ok: false, code: 'payload_too_large', message: 'Terminal message is too large.' };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { ok: false, code: 'invalid_json', message: 'Terminal message is not valid JSON.' };
      }

      if (!isRecord(parsed) || typeof parsed.type !== 'string') {
        return { ok: false, code: 'invalid_message', message: 'Terminal message must include a type.' };
      }

      if (parsed.type === 'input') {
        if (typeof parsed.data !== 'string') {
          return { ok: false, code: 'invalid_message', message: 'Input message data must be a string.' };
        }
        return { ok: true, message: { type: 'input', data: parsed.data } };
      }

      if (parsed.type === 'resize') {
        if (!isFiniteInteger(parsed.cols) || !isFiniteInteger(parsed.rows)) {
          return { ok: false, code: 'invalid_message', message: 'Resize message must include integer cols and rows.' };
        }
        if (parsed.cols < MIN_COLS || parsed.cols > MAX_COLS || parsed.rows < MIN_ROWS || parsed.rows > MAX_ROWS) {
          return { ok: false, code: 'resize_out_of_bounds', message: 'Resize dimensions are outside the allowed bounds.' };
        }
        return { ok: true, message: { type: 'resize', cols: parsed.cols, rows: parsed.rows } };
      }

      if (parsed.type === 'ping') {
        if (!isFiniteInteger(parsed.ts)) {
          return { ok: false, code: 'invalid_message', message: 'Ping message must include integer ts.' };
        }
        return { ok: true, message: { type: 'ping', ts: parsed.ts } };
      }

      return { ok: false, code: 'invalid_message', message: `Unsupported terminal message type: ${parsed.type}` };
    },

    encodeServerMessage(message) {
      return JSON.stringify(message);
    },
  };
}
