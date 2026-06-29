import { describe, expect, test } from 'vitest';
import { startExpirySweeper, type ExpiringStore, type IntervalScheduler } from './sweeper';

class CountingStore implements ExpiringStore {
  sweepCount = 0;
  sweepExpired(): void {
    this.sweepCount += 1;
  }
}

function createManualScheduler(): {
  scheduler: IntervalScheduler;
  tick(): void;
  intervalMs: number | null;
  stopped: boolean;
} {
  let tickCallback: (() => void) | null = null;
  let intervalMs: number | null = null;
  let stopped = false;
  const scheduler: IntervalScheduler = (onTick, ms) => {
    tickCallback = onTick;
    intervalMs = ms;
    return () => {
      stopped = true;
    };
  };
  return {
    scheduler,
    tick: () => tickCallback?.(),
    get intervalMs() {
      return intervalMs;
    },
    get stopped() {
      return stopped;
    },
  };
}

describe('expiry sweeper', () => {
  test('sweeps every registered store on each scheduler tick', () => {
    const tickets = new CountingStore();
    const sessions = new CountingStore();
    const manual = createManualScheduler();

    startExpirySweeper([tickets, sessions], 10_000, manual.scheduler);
    expect(manual.intervalMs).toBe(10_000);
    expect(tickets.sweepCount).toBe(0);

    manual.tick();
    manual.tick();

    expect(tickets.sweepCount).toBe(2);
    expect(sessions.sweepCount).toBe(2);
  });

  test('stopping the sweeper cancels the scheduled interval', () => {
    const manual = createManualScheduler();
    const stop = startExpirySweeper([new CountingStore()], 10_000, manual.scheduler);

    expect(manual.stopped).toBe(false);
    stop();
    expect(manual.stopped).toBe(true);
  });

  test('a single failing store does not stop the others from being swept', () => {
    const exploding: ExpiringStore = {
      sweepExpired: () => {
        throw new Error('boom');
      },
    };
    const healthy = new CountingStore();
    const manual = createManualScheduler();

    startExpirySweeper([exploding, healthy], 10_000, manual.scheduler);
    manual.tick();

    expect(healthy.sweepCount).toBe(1);
  });
});
