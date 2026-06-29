export type OutputBackpressureOptions = {
  // Pause the source once the consumer's buffered bytes reach this mark.
  highWaterMark: number;
  // Resume the source once the consumer drains back to this mark.
  lowWaterMark: number;
  pause: () => void;
  resume: () => void;
};

export type OutputBackpressure = {
  // Feed the consumer's current buffered byte count (e.g. ws.bufferedAmount)
  // after each send and on each drain; this drives pause/resume.
  observe: (bufferedBytes: number) => void;
  readonly paused: boolean;
};

/**
 * Decides when to pause and resume a terminal output source based on how much
 * the consumer has buffered, using two marks so the source doesn't flap on every
 * byte (#19). Pure and side-effect free except for the injected pause/resume, so
 * the rule is testable without a real WebSocket or SSH channel.
 *
 * Without this, a flood like `yes` or `cat huge_file` lets the SSH channel
 * outrun the WebSocket: bufferedAmount grows unbounded and the browser tab
 * freezes. Pausing the channel propagates backpressure end to end (PTY -> SSH ->
 * server -> WS -> browser). Input is never paused, so Ctrl-C still interrupts.
 *
 * @example
 * const backpressure = createOutputBackpressure({
 *   highWaterMark: 1_048_576,
 *   lowWaterMark: 262_144,
 *   pause: () => session.pause(),
 *   resume: () => session.resume(),
 * });
 * ws.send(chunk, () => backpressure.observe(ws.bufferedAmount));
 * backpressure.observe(ws.bufferedAmount);
 */
export function createOutputBackpressure(
  options: OutputBackpressureOptions,
): OutputBackpressure {
  const { highWaterMark, lowWaterMark, pause, resume } = options;
  if (lowWaterMark >= highWaterMark) {
    throw new Error(
      `Invalid backpressure marks: low-water (${lowWaterMark}) must be below high-water (${highWaterMark}).`,
    );
  }

  let paused = false;

  return {
    observe(bufferedBytes: number): void {
      if (!paused && bufferedBytes >= highWaterMark) {
        paused = true;
        pause();
        return;
      }
      if (paused && bufferedBytes <= lowWaterMark) {
        paused = false;
        resume();
      }
    },
    get paused(): boolean {
      return paused;
    },
  };
}
