import type {
  ClientMessage,
  ParseClientMessageResult,
  ServerMessage,
} from "@omxterm/core/protocol";

export type TerminalTrafficLimits = {
  // Length of the fixed rate-budget window.
  windowMs: number;
  // Inbound frames allowed per window before the connection is closed.
  maxMessagesPerWindow: number;
  // Inbound bytes allowed per window before the connection is closed.
  maxBytesPerWindow: number;
  // Bytes of not-yet-written input the broker will hold while the SSH channel
  // pushes back, before it treats the backlog as sustained overflow and closes.
  maxQueuedInputBytes: number;
};

export type InboundOverflowReason =
  | "inbound_message_rate"
  | "inbound_byte_rate"
  | "inbound_backlog";

export type TerminalInboundGuardDeps = {
  limits: TerminalTrafficLimits;
  // Injected clock so the rate window is testable without real timers.
  now: () => number;
  // Defers a resize apply to the next event-loop turn (e.g. setImmediate), so a
  // synchronous burst of resizes collapses into one apply + one audit write.
  scheduleResizeFlush: (flush: () => void) => void;
  parseFrame: (text: string) => ParseClientMessageResult;
  // Writes input to the SSH channel; returns false on write backpressure.
  writeInput: (data: string) => boolean;
  // Subscribes to the SSH channel's drain; returns an unsubscribe.
  subscribeDrain: (listener: () => void) => () => void;
  // Applies a resize to the SSH channel and audits it (the guard decides when).
  applyResize: (cols: number, rows: number) => void;
  // Returns xterm parser capacity to the outbound flow controller.
  acknowledgeOutput: (id: number, bytes: number) => void;
  sendMessage: (message: ServerMessage) => void;
  // Invoked once when a budget is exceeded; the broker closes the connection.
  onOverflow: (reason: InboundOverflowReason) => void;
};

export type TerminalInboundGuard = {
  handleFrame(text: string): void;
  dispose(): void;
};

type Size = { cols: number; rows: number };

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * Governs one terminal connection's inbound side so an authenticated client
 * cannot outrun the broker, the SSH target, or the audit sink (#77). It is
 * specific to a single connection — not a shared or multi-tenant quota.
 *
 * Four bounds, all with explicit overflow behavior:
 * - a fixed-window byte/message budget that closes the connection on a flood
 *   (this alone caps ping, invalid-message, and resize response work);
 * - a strictly bounded input queue that honors SSH write backpressure and
 *   closes on sustained overflow instead of buffering without limit;
 * - resize coalescing that collapses redundant/bursty resizes into at most one
 *   apply per tick, preventing synchronous audit amplification;
 * - dedupe of unchanged resize dimensions.
 *
 * Legitimate traffic is untouched: input is written immediately (Ctrl-C stays
 * responsive), pastes within the payload limit pass through, and resizes apply
 * within a tick.
 */
export function createTerminalInboundGuard(
  deps: TerminalInboundGuardDeps,
): TerminalInboundGuard {
  const { limits } = deps;

  let stopped = false;

  // Fixed-window rate budget.
  let windowStart = deps.now();
  let windowMessages = 0;
  let windowBytes = 0;

  // Bounded input queue honoring SSH write backpressure.
  const inputQueue: string[] = [];
  let queuedBytes = 0;
  let channelWritable = true;
  const unsubscribeDrain = deps.subscribeDrain(() => {
    channelWritable = true;
    flushInput();
  });

  // Coalesced resize state.
  let pendingResize: Size | null = null;
  let resizeFlushScheduled = false;
  let lastAppliedResize: Size | null = null;

  function fail(reason: InboundOverflowReason): void {
    stopped = true;
    deps.onOverflow(reason);
  }

  // Returns the reason to close on, or null when the frame fits the budget.
  function admit(frameBytes: number): InboundOverflowReason | null {
    const nowMs = deps.now();
    if (nowMs - windowStart >= limits.windowMs) {
      windowStart = nowMs;
      windowMessages = 0;
      windowBytes = 0;
    }
    windowMessages += 1;
    windowBytes += frameBytes;
    if (windowMessages > limits.maxMessagesPerWindow) return "inbound_message_rate";
    if (windowBytes > limits.maxBytesPerWindow) return "inbound_byte_rate";
    return null;
  }

  function flushInput(): void {
    while (inputQueue.length > 0 && channelWritable && !stopped) {
      const chunk = inputQueue.shift() as string;
      queuedBytes -= byteLength(chunk);
      // ssh2 still accepts the chunk when write() returns false; false only
      // signals to stop feeding until drain, so consume it and then pause.
      if (!deps.writeInput(chunk)) {
        channelWritable = false;
        return;
      }
    }
  }

  function enqueueInput(data: string): void {
    const length = byteLength(data);
    if (queuedBytes + length > limits.maxQueuedInputBytes) {
      fail("inbound_backlog");
      return;
    }
    inputQueue.push(data);
    queuedBytes += length;
    flushInput();
  }

  function queueResize(cols: number, rows: number): void {
    pendingResize = { cols, rows };
    if (resizeFlushScheduled) return;
    resizeFlushScheduled = true;
    deps.scheduleResizeFlush(flushResize);
  }

  function flushResize(): void {
    resizeFlushScheduled = false;
    if (stopped || !pendingResize) return;
    const { cols, rows } = pendingResize;
    pendingResize = null;
    if (
      lastAppliedResize &&
      lastAppliedResize.cols === cols &&
      lastAppliedResize.rows === rows
    ) {
      return;
    }
    lastAppliedResize = { cols, rows };
    deps.applyResize(cols, rows);
  }

  function dispatch(message: ClientMessage): void {
    if (message.type === "input") {
      enqueueInput(message.data);
      return;
    }
    if (message.type === "resize") {
      queueResize(message.cols, message.rows);
      return;
    }
    if (message.type === "output_ack") {
      deps.acknowledgeOutput(message.id, message.bytes);
      return;
    }
    deps.sendMessage({ type: "pong", ts: message.ts });
  }

  return {
    handleFrame(text: string): void {
      if (stopped) return;
      const overflow = admit(byteLength(text));
      if (overflow) {
        fail(overflow);
        return;
      }
      const parsed = deps.parseFrame(text);
      if (!parsed.ok) {
        deps.sendMessage({
          type: "error",
          code: parsed.code,
          message: parsed.message,
        });
        return;
      }
      dispatch(parsed.message);
    },
    dispose(): void {
      stopped = true;
      unsubscribeDrain();
      inputQueue.length = 0;
      queuedBytes = 0;
      pendingResize = null;
    },
  };
}
