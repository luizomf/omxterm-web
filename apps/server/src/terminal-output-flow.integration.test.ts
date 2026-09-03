import { createJsonTerminalProtocolCodec } from "@omxterm/core/protocol";
import type { ServerMessage } from "@omxterm/core/protocol";
import { describe, expect, test } from "vitest";
import { createTerminalInboundGuard } from "./terminal-inbound-guard";
import { createTerminalOutputFlow } from "./terminal-output-flow";

type OutputMessage = Extract<ServerMessage, { type: "output" }>;

describe("terminal output flow integration", () => {
  test("sustained output stays bounded and ordered while Ctrl-C remains responsive", () => {
    const codec = createJsonTerminalProtocolCodec();
    const source = Array.from(
      { length: 80 },
      (_, index) => `block-${index.toString().padStart(2, "0")}-🌎\n`,
    );
    const expected = source.join("");
    const parserQueue: OutputMessage[] = [];
    const rendered: string[] = [];
    const inputWrites: string[] = [];
    const invalidAcks: string[] = [];
    let sourceIndex = 0;
    let sourcePaused = false;
    let pendingBrowserBytes = 0;
    let peakPendingBrowserBytes = 0;

    const output = createTerminalOutputFlow({
      maxInFlightBytes: 24,
      maxChunkBytes: 8,
      send: message => {
        parserQueue.push(message);
        pendingBrowserBytes += message.bytes;
        peakPendingBrowserBytes = Math.max(
          peakPendingBrowserBytes,
          pendingBrowserBytes,
        );
      },
      pause: () => {
        sourcePaused = true;
      },
      resume: () => {
        sourcePaused = false;
      },
      onInvalidAck: reason => invalidAcks.push(reason),
    });

    const inbound = createTerminalInboundGuard({
      limits: {
        windowMs: 1000,
        maxMessagesPerWindow: 1000,
        maxBytesPerWindow: 1024 * 1024,
        maxQueuedInputBytes: 1024,
      },
      now: () => 0,
      scheduleResizeFlush: flush => flush(),
      parseFrame: text => codec.parseClientMessage(text),
      writeInput: data => {
        inputWrites.push(data);
        return true;
      },
      subscribeDrain: () => () => {},
      applyResize: () => {},
      acknowledgeOutput: (id, bytes) => output.acknowledge(id, bytes),
      sendMessage: () => {},
      onOverflow: reason => {
        throw new Error(`unexpected overflow: ${reason}`);
      },
    });

    const pumpSource = () => {
      while (!sourcePaused && sourceIndex < source.length) {
        output.push(source[sourceIndex] as string);
        sourceIndex += 1;
      }
    };

    pumpSource();
    while (parserQueue.length > 0 || sourceIndex < source.length) {
      if (sourcePaused) {
        inbound.handleFrame(JSON.stringify({ type: "input", data: "\u0003" }));
      }
      const parsed = parserQueue.shift();
      if (parsed) {
        rendered.push(parsed.data);
        pendingBrowserBytes -= parsed.bytes;
        inbound.handleFrame(
          JSON.stringify({
            type: "output_ack",
            id: parsed.id,
            bytes: parsed.bytes,
          }),
        );
      }
      pumpSource();
    }

    expect(rendered.join("")).toBe(expected);
    expect(peakPendingBrowserBytes).toBeLessThanOrEqual(24);
    expect(pendingBrowserBytes).toBe(0);
    expect(inputWrites).toContain("\u0003");
    expect(invalidAcks).toEqual([]);
    inbound.dispose();
    output.dispose();
  });
});
