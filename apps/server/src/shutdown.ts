export type ShutdownDeadlineDependencies = {
  deadlineMs: number;
  writeError: (message: string) => void;
  forceExit: (code: number) => void;
  markFailure: () => void;
};

/**
 * Closes the broker while leaving an unref'ed hard deadline armed. The timer
 * does not keep a clean process alive, but it still terminates shutdown when an
 * SSH transport or another referenced handle outlives Fastify's close promise.
 */
export async function closeServerWithinDeadline(
  signal: NodeJS.Signals,
  closeServer: () => Promise<void>,
  dependencies: ShutdownDeadlineDependencies,
): Promise<void> {
  const forceExit = setTimeout(() => {
    dependencies.writeError(
      `${JSON.stringify({ level: 'error', msg: 'shutdown_timeout', signal })}\n`,
    );
    dependencies.forceExit(1);
  }, dependencies.deadlineMs);
  forceExit.unref();

  try {
    await closeServer();
    // Do not clear the deadline here. Fastify can finish closing its
    // HTTP/WebSocket layer while an SSH transport still owns a referenced
    // socket; the unref'ed timer exits naturally only when no such handle is
    // left, and forces termination when one stalls.
  } catch (error) {
    dependencies.writeError(
      `${JSON.stringify({
        level: 'error',
        msg: 'shutdown_failed',
        signal,
        error: error instanceof Error ? error.message : 'unknown_error',
      })}\n`,
    );
    dependencies.markFailure();
  }
}
