import type { ServerMessage } from "@omxterm/core/protocol";
import { describe, expect, test } from "vitest";
import {
  createTerminalOutputFlow,
  type InvalidOutputAckReason,
} from "./terminal-output-flow";

type OutputMessage = Extract<ServerMessage, { type: "output" }>;

function createHarness(maxInFlightBytes = 10, maxChunkBytes = 6) {
  const sent: OutputMessage[] = [];
  const pauses: string[] = [];
  const invalid: InvalidOutputAckReason[] = [];
  const flow = createTerminalOutputFlow({
    maxInFlightBytes,
    maxChunkBytes,
    send: message => sent.push(message),
    pause: () => pauses.push("pause"),
    resume: () => pauses.push("resume"),
    onInvalidAck: reason => invalid.push(reason),
  });
  return { flow, sent, pauses, invalid };
}

describe("createTerminalOutputFlow", () => {
  test("keeps in-flight UTF-8 bytes bounded and resumes in original order", () => {
    const harness = createHarness();

    harness.flow.push("abc🌎defghij");

    expect(harness.flow.inFlightBytes).toBeLessThanOrEqual(10);
    expect(harness.pauses).toEqual(["pause"]);
    const first = harness.sent[0] as OutputMessage;
    harness.flow.acknowledge(first.id, first.bytes);
    expect(harness.flow.inFlightBytes).toBeLessThanOrEqual(10);
    const ackedIds = new Set([first.id]);

    while (harness.flow.inFlightBytes > 0 || harness.flow.queuedBytes > 0) {
      const next = harness.sent.find(
        message => !ackedIds.has(message.id),
      ) as OutputMessage;
      ackedIds.add(next.id);
      harness.flow.acknowledge(next.id, next.bytes);
    }

    expect(harness.sent.map(message => message.data).join("")).toBe(
      "abc🌎defghij",
    );
    expect(harness.sent.map(message => message.id)).toEqual(
      harness.sent.map((_, index) => index + 1),
    );
    expect(harness.pauses.at(-1)).toBe("resume");
  });

  test("rejects duplicate, out-of-order, and byte-mismatched ACKs", () => {
    const harness = createHarness();
    harness.flow.push("abcdefghij");
    const first = harness.sent[0] as OutputMessage;
    const second = harness.sent[1] as OutputMessage;

    harness.flow.acknowledge(second.id, second.bytes);
    harness.flow.acknowledge(first.id, first.bytes + 1);
    harness.flow.acknowledge(first.id, first.bytes);
    harness.flow.acknowledge(first.id, first.bytes);

    expect(harness.invalid).toEqual([
      "unexpected_output_id",
      "output_byte_mismatch",
      "unexpected_output_id",
    ]);
  });

  test("rejects an ACK when no output is pending", () => {
    const harness = createHarness();

    harness.flow.acknowledge(1, 1);

    expect(harness.invalid).toEqual(["no_pending_output"]);
  });

  test("clears pending state and ignores late work after disposal", () => {
    const harness = createHarness();
    harness.flow.push("abcdefghijklmno");
    const first = harness.sent[0] as OutputMessage;

    harness.flow.dispose();
    harness.flow.acknowledge(first.id, first.bytes);
    harness.flow.push("late");

    expect(harness.flow.inFlightBytes).toBe(0);
    expect(harness.flow.queuedBytes).toBe(0);
    expect(harness.invalid).toEqual([]);
  });
});
