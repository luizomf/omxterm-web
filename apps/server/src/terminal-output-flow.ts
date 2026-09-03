import type { ServerMessage } from "@omxterm/core/protocol";

type OutputMessage = Extract<ServerMessage, { type: "output" }>;

export type InvalidOutputAckReason =
  | "no_pending_output"
  | "unexpected_output_id"
  | "output_byte_mismatch";

export type TerminalOutputFlow = {
  push(data: string): void;
  acknowledge(id: number, bytes: number): void;
  finish(onDrained: () => void): void;
  dispose(): void;
  readonly inFlightBytes: number;
  readonly queuedBytes: number;
};

type TerminalOutputFlowDeps = {
  maxInFlightBytes: number;
  maxChunkBytes: number;
  send: (message: OutputMessage) => void;
  pause: () => void;
  resume: () => void;
  onInvalidAck: (reason: InvalidOutputAckReason) => void;
};

type PendingOutput = { id: number; bytes: number };

function splitUtf8Prefix(
  value: string,
  maxBytes: number,
): { prefix: string; rest: string; bytes: number } {
  let codeUnits = 0;
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    bytes += characterBytes;
    codeUnits += character.length;
  }
  return {
    prefix: value.slice(0, codeUnits),
    rest: value.slice(codeUnits),
    bytes,
  };
}

/**
 * Reserves finite parser credit before sending each output block. Capacity is
 * returned only by the matching, oldest ACK, which is emitted by the browser
 * after xterm's write callback. Source text is split only on Unicode code-point
 * boundaries, preserving UTF-8 bytes and ordering.
 */
export function createTerminalOutputFlow(
  deps: TerminalOutputFlowDeps,
): TerminalOutputFlow {
  if (
    deps.maxInFlightBytes < 1 ||
    deps.maxChunkBytes < 1 ||
    deps.maxChunkBytes > deps.maxInFlightBytes
  ) {
    throw new Error("Invalid terminal output flow limits.");
  }

  const queue: string[] = [];
  const pending: PendingOutput[] = [];
  let queuedBytes = 0;
  let inFlightBytes = 0;
  let nextId = 1;
  let paused = false;
  let finishing = false;
  let onDrained: (() => void) | null = null;
  let disposed = false;

  function setPaused(next: boolean): void {
    if (paused === next || disposed) return;
    paused = next;
    if (next) deps.pause();
    else deps.resume();
  }

  function flush(): void {
    while (!disposed && queue.length > 0) {
      const capacity = deps.maxInFlightBytes - inFlightBytes;
      if (capacity === 0) break;
      const source = queue[0] as string;
      const part = splitUtf8Prefix(
        source,
        Math.min(capacity, deps.maxChunkBytes),
      );
      if (part.bytes === 0) break;

      if (part.rest.length === 0) queue.shift();
      else queue[0] = part.rest;
      queuedBytes -= part.bytes;

      const output = { id: nextId, bytes: part.bytes };
      nextId += 1;
      pending.push(output);
      inFlightBytes += part.bytes;
      deps.send({ type: "output", ...output, data: part.prefix });
    }

    setPaused(inFlightBytes === deps.maxInFlightBytes || queue.length > 0);
    if (finishing && queue.length === 0 && pending.length === 0) {
      const complete = onDrained;
      onDrained = null;
      complete?.();
    }
  }

  function rejectAck(reason: InvalidOutputAckReason): void {
    if (disposed) return;
    deps.onInvalidAck(reason);
  }

  return {
    push(data): void {
      if (disposed || finishing || data.length === 0) return;
      queue.push(data);
      queuedBytes += Buffer.byteLength(data, "utf8");
      flush();
    },
    acknowledge(id, bytes): void {
      if (disposed) return;
      const expected = pending[0];
      if (!expected) {
        rejectAck("no_pending_output");
        return;
      }
      if (id !== expected.id) {
        rejectAck("unexpected_output_id");
        return;
      }
      if (bytes !== expected.bytes) {
        rejectAck("output_byte_mismatch");
        return;
      }
      pending.shift();
      inFlightBytes -= bytes;
      flush();
    },
    finish(complete): void {
      if (disposed || finishing) return;
      finishing = true;
      onDrained = complete;
      flush();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      queue.length = 0;
      pending.length = 0;
      queuedBytes = 0;
      inFlightBytes = 0;
      onDrained = null;
    },
    get inFlightBytes(): number {
      return inFlightBytes;
    },
    get queuedBytes(): number {
      return queuedBytes;
    },
  };
}
