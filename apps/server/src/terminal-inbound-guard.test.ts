import { createJsonTerminalProtocolCodec } from "@omxterm/core/protocol";
import type { ServerMessage } from "@omxterm/core/protocol";
import { describe, expect, test } from "vitest";
import {
  createTerminalInboundGuard,
  type InboundOverflowReason,
  type TerminalTrafficLimits,
} from "./terminal-inbound-guard";

const codec = createJsonTerminalProtocolCodec();

const generousLimits: TerminalTrafficLimits = {
  windowMs: 1000,
  maxMessagesPerWindow: 1000,
  maxBytesPerWindow: 10 * 1024 * 1024,
  maxQueuedInputBytes: 1024 * 1024,
};

// A scriptable harness that drives the guard through its injected seams: a fake
// SSH writer (with controllable backpressure + drain), a fake transport sink,
// a manual clock, and a manual resize scheduler. Nothing here touches a real
// WebSocket or SSH channel, so the guard's observable behavior is deterministic.
function createHarness(overrides: Partial<TerminalTrafficLimits> = {}) {
  let clock = 0;
  let writeAccepts = true;
  let pendingResizeFlush: (() => void) | null = null;
  let drainListener: (() => void) | null = null;

  const writes: string[] = [];
  const resizes: Array<{ cols: number; rows: number }> = [];
  const sent: ServerMessage[] = [];
  const acknowledgements: Array<{ id: number; bytes: number }> = [];
  const overflows: InboundOverflowReason[] = [];

  const guard = createTerminalInboundGuard({
    limits: { ...generousLimits, ...overrides },
    now: () => clock,
    scheduleResizeFlush: (flush) => {
      pendingResizeFlush = flush;
    },
    parseFrame: (text) => codec.parseClientMessage(text),
    writeInput: (data) => {
      writes.push(data);
      return writeAccepts;
    },
    subscribeDrain: (listener) => {
      drainListener = listener;
      return () => {
        drainListener = null;
      };
    },
    applyResize: (cols, rows) => resizes.push({ cols, rows }),
    acknowledgeOutput: (id, bytes) => acknowledgements.push({ id, bytes }),
    sendMessage: (message) => sent.push(message),
    onOverflow: (reason) => overflows.push(reason),
  });

  return {
    guard,
    writes,
    resizes,
    sent,
    acknowledgements,
    overflows,
    input: (data: string) => guard.handleFrame(JSON.stringify({ type: "input", data })),
    resize: (cols: number, rows: number) =>
      guard.handleFrame(JSON.stringify({ type: "resize", cols, rows })),
    ping: (ts: number) => guard.handleFrame(JSON.stringify({ type: "ping", ts })),
    acknowledge: (id: number, bytes: number) =>
      guard.handleFrame(JSON.stringify({ type: "output_ack", id, bytes })),
    raw: (text: string) => guard.handleFrame(text),
    advanceClock: (ms: number) => {
      clock += ms;
    },
    setWriteAccepts: (value: boolean) => {
      writeAccepts = value;
    },
    flushResize: () => {
      const flush = pendingResizeFlush;
      pendingResizeFlush = null;
      flush?.();
    },
    hasScheduledResizeFlush: () => pendingResizeFlush !== null,
    emitDrain: () => drainListener?.(),
    hasDrainListener: () => drainListener !== null,
  };
}

describe("createTerminalInboundGuard legitimate traffic", () => {
  test("forwards keystroke input straight to the SSH channel without waiting for a tick", () => {
    const harness = createHarness();

    harness.input("ls -la\n");

    expect(harness.writes).toEqual(["ls -la\n"]);
  });

  test("delivers a Ctrl-C interrupt immediately", () => {
    const harness = createHarness();

    harness.input("");

    expect(harness.writes).toEqual([""]);
  });

  test("forwards a paste within the payload limit as input", () => {
    const harness = createHarness();
    const paste = "x".repeat(60 * 1024);

    harness.input(paste);

    expect(harness.writes).toEqual([paste]);
  });

  test("answers a ping with a matching pong", () => {
    const harness = createHarness();

    harness.ping(42);

    expect(harness.sent).toEqual([{ type: "pong", ts: 42 }]);
  });

  test("forwards a valid output acknowledgement to outbound flow control", () => {
    const harness = createHarness();

    harness.acknowledge(4, 1024);

    expect(harness.acknowledgements).toEqual([{ id: 4, bytes: 1024 }]);
  });

  test("does not charge broker-correlated ACKs to the interactive message budget", () => {
    const harness = createHarness({ maxMessagesPerWindow: 1 });

    for (let id = 1; id <= 513; id += 1) {
      harness.acknowledge(id, 1);
    }
    harness.ping(1);

    expect(harness.acknowledgements).toHaveLength(513);
    expect(harness.sent).toEqual([{ type: "pong", ts: 1 }]);
    expect(harness.overflows).toEqual([]);

    harness.ping(2);
    expect(harness.overflows).toEqual(["inbound_message_rate"]);
  });

  test("responds to a malformed frame with a single error and no crash", () => {
    const harness = createHarness();

    harness.raw("this is not json");

    expect(harness.sent).toEqual([
      { type: "error", code: "invalid_json", message: expect.any(String) },
    ]);
    expect(harness.overflows).toEqual([]);
  });
});

describe("createTerminalInboundGuard resize coalescing (#77)", () => {
  test("collapses a synchronous burst of identical resizes into a single apply", () => {
    const harness = createHarness();

    for (let i = 0; i < 25; i += 1) harness.resize(120, 34);
    harness.flushResize();

    expect(harness.resizes).toEqual([{ cols: 120, rows: 34 }]);
  });

  test("applies only the latest dimensions from a burst of changing resizes", () => {
    const harness = createHarness();

    harness.resize(80, 24);
    harness.resize(100, 30);
    harness.resize(120, 34);
    harness.flushResize();

    expect(harness.resizes).toEqual([{ cols: 120, rows: 34 }]);
  });

  test("skips re-applying and re-auditing an unchanged size across ticks", () => {
    const harness = createHarness();

    harness.resize(100, 30);
    harness.flushResize();
    harness.resize(100, 30);
    harness.flushResize();

    expect(harness.resizes).toEqual([{ cols: 100, rows: 30 }]);
  });

  test("applies a genuinely changed size on a later tick", () => {
    const harness = createHarness();

    harness.resize(100, 30);
    harness.flushResize();
    harness.resize(120, 34);
    harness.flushResize();

    expect(harness.resizes).toEqual([
      { cols: 100, rows: 30 },
      { cols: 120, rows: 34 },
    ]);
  });
});

describe("createTerminalInboundGuard inbound rate budget (#77)", () => {
  test("closes the connection once inbound messages exceed the per-window budget", () => {
    const harness = createHarness({ maxMessagesPerWindow: 3 });

    harness.ping(1);
    harness.ping(2);
    harness.ping(3);
    harness.ping(4);

    expect(harness.overflows).toEqual(["inbound_message_rate"]);
    // The offending frame and everything after it produce no further responses.
    expect(harness.sent).toHaveLength(3);
  });

  test("stops doing any work after an overflow close", () => {
    const harness = createHarness({ maxMessagesPerWindow: 2 });

    harness.ping(1);
    harness.ping(2);
    harness.ping(3);
    harness.input("ignored");
    harness.ping(4);

    expect(harness.overflows).toEqual(["inbound_message_rate"]);
    expect(harness.sent).toHaveLength(2);
    expect(harness.writes).toEqual([]);
  });

  test("resets the message budget after the window elapses", () => {
    const harness = createHarness({ maxMessagesPerWindow: 2, windowMs: 1000 });

    harness.ping(1);
    harness.ping(2);
    harness.advanceClock(1000);
    harness.ping(3);

    expect(harness.overflows).toEqual([]);
    expect(harness.sent).toHaveLength(3);
  });

  test("closes the connection once inbound bytes exceed the per-window budget", () => {
    const harness = createHarness({ maxBytesPerWindow: 60, maxMessagesPerWindow: 100 });

    harness.input("a".repeat(30));
    harness.input("b".repeat(30));

    expect(harness.overflows).toEqual(["inbound_byte_rate"]);
  });
});

describe("createTerminalInboundGuard SSH write backpressure (#77)", () => {
  test("bounds memory and closes when a non-draining channel overflows the input backlog", () => {
    const harness = createHarness({ maxQueuedInputBytes: 30 });
    harness.setWriteAccepts(false);

    // First chunk is handed to the channel (which pushes back); the rest queue
    // until the strict backlog bound trips and the connection is closed.
    harness.input("a".repeat(20));
    harness.input("b".repeat(20));
    harness.input("c".repeat(20));

    expect(harness.overflows).toEqual(["inbound_backlog"]);
    expect(harness.writes).toEqual(["a".repeat(20)]);
  });

  test("resumes draining queued input in order after the channel drains", () => {
    const harness = createHarness();
    harness.setWriteAccepts(false);

    harness.input("first");
    harness.input("second");
    expect(harness.writes).toEqual(["first"]);

    harness.setWriteAccepts(true);
    harness.emitDrain();

    expect(harness.writes).toEqual(["first", "second"]);
    expect(harness.overflows).toEqual([]);
  });
});

describe("createTerminalInboundGuard dispose (#77)", () => {
  test("unsubscribes drain and prevents a scheduled resize flush from applying", () => {
    const harness = createHarness();

    harness.resize(120, 34);
    expect(harness.hasScheduledResizeFlush()).toBe(true);
    harness.guard.dispose();
    harness.flushResize();

    expect(harness.resizes).toEqual([]);
    expect(harness.hasDrainListener()).toBe(false);
  });
});
