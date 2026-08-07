import { afterEach, describe, expect, test, vi } from 'vitest';
import { closeServerWithinDeadline } from './shutdown';

describe('closeServerWithinDeadline', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('keeps the hard deadline armed after Fastify close resolves', async () => {
    vi.useFakeTimers();
    const writeError = vi.fn();
    const forceExit = vi.fn();

    await closeServerWithinDeadline('SIGTERM', async () => {}, {
      deadlineMs: 10_000,
      writeError,
      forceExit,
      markFailure: vi.fn(),
    });

    expect(forceExit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(forceExit).toHaveBeenCalledWith(1);
    expect(writeError).toHaveBeenCalledWith(
      `${JSON.stringify({
        level: 'error',
        msg: 'shutdown_timeout',
        signal: 'SIGTERM',
      })}\n`,
    );
  });

  test('marks a close failure without discarding its diagnostic', async () => {
    vi.useFakeTimers();
    const writeError = vi.fn();
    const markFailure = vi.fn();

    await closeServerWithinDeadline(
      'SIGINT',
      async () => {
        throw new Error('close failed');
      },
      {
        deadlineMs: 10_000,
        writeError,
        forceExit: vi.fn(),
        markFailure,
      },
    );

    expect(markFailure).toHaveBeenCalledOnce();
    expect(writeError).toHaveBeenCalledWith(
      expect.stringContaining('close failed'),
    );
  });
});
