import { describe, expect, test } from "vitest";
import { createTerminalOutputPause } from "./terminal-output-pause";

describe("createTerminalOutputPause", () => {
  test("resumes only after every independent pause reason clears", () => {
    const calls: string[] = [];
    const pause = createTerminalOutputPause({
      pause: () => calls.push("pause"),
      resume: () => calls.push("resume"),
    });

    pause.pauseFor("parser_credit");
    pause.pauseFor("websocket_buffer");
    pause.resumeFor("parser_credit");
    expect(calls).toEqual(["pause"]);

    pause.resumeFor("websocket_buffer");
    expect(calls).toEqual(["pause", "resume"]);
  });

  test("ignores delayed releases after disposal", () => {
    const calls: string[] = [];
    const pause = createTerminalOutputPause({
      pause: () => calls.push("pause"),
      resume: () => calls.push("resume"),
    });

    pause.pauseFor("parser_credit");
    pause.dispose();
    pause.resumeFor("parser_credit");

    expect(calls).toEqual(["pause"]);
  });
});
