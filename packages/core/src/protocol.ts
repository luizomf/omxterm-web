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

// Shared resize contract for the terminal grid the broker accepts and the
// frontend fits to. The old 240x100 cap rejected legitimate large layouts: at
// the shipped font a 2560x2160 CSS viewport fits ~304x128 cells (#80). The
// bounds below cover that and 4K panels with headroom, while still rejecting
// absurd dimensions that would burden the PTY or the remote program. Both the
// server (validation here) and the client (clampTerminalSize) import these, so
// xterm's grid and the PTY can never drift onto different sizes.
export const TERMINAL_SIZE_BOUNDS = {
  minCols: 20,
  maxCols: 512,
  minRows: 5,
  maxRows: 256,
} as const;

function clampToRange(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Clamps a fitted terminal grid into the shared {@link TERMINAL_SIZE_BOUNDS} so
 * the frontend can keep xterm and the PTY on the same size instead of sending a
 * dimension the broker would reject and leaving the two silently diverged (#80).
 *
 * @example
 * clampTerminalSize(304, 128); // { cols: 304, rows: 128 }
 * clampTerminalSize(9999, 9999); // { cols: 512, rows: 256 }
 */
export function clampTerminalSize(
  cols: number,
  rows: number,
): { cols: number; rows: number } {
  return {
    cols: clampToRange(cols, TERMINAL_SIZE_BOUNDS.minCols, TERMINAL_SIZE_BOUNDS.maxCols),
    rows: clampToRange(rows, TERMINAL_SIZE_BOUNDS.minRows, TERMINAL_SIZE_BOUNDS.maxRows),
  };
}

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
        if (
          parsed.cols < TERMINAL_SIZE_BOUNDS.minCols ||
          parsed.cols > TERMINAL_SIZE_BOUNDS.maxCols ||
          parsed.rows < TERMINAL_SIZE_BOUNDS.minRows ||
          parsed.rows > TERMINAL_SIZE_BOUNDS.maxRows
        ) {
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
