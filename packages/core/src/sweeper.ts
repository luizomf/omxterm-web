// Active expiry for the in-memory stores (#29). The stores only pruned expired
// entries lazily on their read paths, so an emitted-but-never-consumed terminal
// ticket kept its SSH private key in memory past its 60s TTL until the next
// ticket op happened to touch it. This periodic sweeper drives each store's
// sweepExpired() on a fixed cadence so secret material is dropped on time, even
// while the server is otherwise idle.

// A store that knows how to drop its own expired entries. Kept tiny so the
// sweeper stays decoupled from concrete store types.
export type ExpiringStore = { sweepExpired(): void };

// The scheduler is injected so domain code never imports setInterval/clearInterval
// directly and tests can drive ticks with a fake. It returns a stop() handle.
export type IntervalScheduler = (onTick: () => void, intervalMs: number) => () => void;

export const systemIntervalScheduler: IntervalScheduler = (onTick, intervalMs) => {
  const timer = setInterval(onTick, intervalMs);
  // Don't let the sweep timer alone keep the Node process alive on shutdown.
  timer.unref();
  return () => clearInterval(timer);
};

/**
 * Periodically calls sweepExpired() on every store so expired entries (and the
 * secrets they hold) are removed without waiting for a read on that store.
 *
 * @returns a stop() function that cancels the schedule (call it on shutdown).
 *
 * @example
 * const stop = startExpirySweeper([tickets, sessions, devices], 10_000);
 * // ...later, on server close:
 * stop();
 */
export function startExpirySweeper(
  stores: readonly ExpiringStore[],
  intervalMs: number,
  scheduler: IntervalScheduler = systemIntervalScheduler,
): () => void {
  return scheduler(() => {
    // One store throwing must not skip the rest — tickets hold the SSH key and
    // are the most important to sweep, so isolate failures per store.
    for (const store of stores) {
      try {
        store.sweepExpired();
      } catch {
        // Sweeping is best-effort housekeeping; the lazy read-path cleanup still
        // protects correctness, so swallow and keep going.
      }
    }
  }, intervalMs);
}
