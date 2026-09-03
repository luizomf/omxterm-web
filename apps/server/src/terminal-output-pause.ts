export type OutputPauseReason = "parser_credit" | "websocket_buffer";

export type TerminalOutputPause = {
  pauseFor(reason: OutputPauseReason): void;
  resumeFor(reason: OutputPauseReason): void;
  dispose(): void;
  readonly paused: boolean;
};

/** Coordinates independent output guards so one cannot resume the SSH readable
 * side while another still needs it paused. Input uses the writable side and is
 * intentionally unaffected.
 */
export function createTerminalOutputPause(deps: {
  pause: () => void;
  resume: () => void;
}): TerminalOutputPause {
  const reasons = new Set<OutputPauseReason>();
  let disposed = false;

  return {
    pauseFor(reason): void {
      if (disposed || reasons.has(reason)) return;
      const wasRunning = reasons.size === 0;
      reasons.add(reason);
      if (wasRunning) deps.pause();
    },
    resumeFor(reason): void {
      if (disposed || !reasons.delete(reason)) return;
      if (reasons.size === 0) deps.resume();
    },
    dispose(): void {
      disposed = true;
      reasons.clear();
    },
    get paused(): boolean {
      return reasons.size > 0;
    },
  };
}
