import { describe, expect, test } from 'vitest';
import { createOutputBackpressure } from './terminal-backpressure';

function createRecordingSource() {
  const calls: string[] = [];
  return {
    calls,
    pause: () => void calls.push('pause'),
    resume: () => void calls.push('resume'),
  };
}

function createControllerWith(source: { pause: () => void; resume: () => void }) {
  return createOutputBackpressure({
    highWaterMark: 1000,
    lowWaterMark: 200,
    pause: source.pause,
    resume: source.resume,
  });
}

describe('createOutputBackpressure', () => {
  test('pauses the source once buffered output reaches the high-water mark', () => {
    const source = createRecordingSource();
    const backpressure = createControllerWith(source);

    backpressure.observe(1000);

    expect(source.calls).toEqual(['pause']);
    expect(backpressure.paused).toBe(true);
  });

  test('does not pause again while already paused', () => {
    const source = createRecordingSource();
    const backpressure = createControllerWith(source);

    backpressure.observe(1000);
    backpressure.observe(1500);

    expect(source.calls).toEqual(['pause']);
  });

  test('stays below the high-water mark without pausing', () => {
    const source = createRecordingSource();
    const backpressure = createControllerWith(source);

    backpressure.observe(999);

    expect(source.calls).toEqual([]);
    expect(backpressure.paused).toBe(false);
  });

  test('resumes once buffered output drains to the low-water mark', () => {
    const source = createRecordingSource();
    const backpressure = createControllerWith(source);

    backpressure.observe(1000);
    backpressure.observe(200);

    expect(source.calls).toEqual(['pause', 'resume']);
    expect(backpressure.paused).toBe(false);
  });

  test('stays paused while buffered output sits between the marks (hysteresis)', () => {
    const source = createRecordingSource();
    const backpressure = createControllerWith(source);

    backpressure.observe(1000);
    backpressure.observe(500);

    expect(source.calls).toEqual(['pause']);
    expect(backpressure.paused).toBe(true);
  });

  test('never resumes a source that was never paused', () => {
    const source = createRecordingSource();
    const backpressure = createControllerWith(source);

    backpressure.observe(0);

    expect(source.calls).toEqual([]);
  });

  test('re-arms: pauses again after a drain and refill', () => {
    const source = createRecordingSource();
    const backpressure = createControllerWith(source);

    backpressure.observe(1000);
    backpressure.observe(200);
    backpressure.observe(1000);

    expect(source.calls).toEqual(['pause', 'resume', 'pause']);
  });

  test('rejects a low-water mark that is not below the high-water mark', () => {
    expect(() =>
      createOutputBackpressure({
        highWaterMark: 100,
        lowWaterMark: 100,
        pause: () => {},
        resume: () => {},
      }),
    ).toThrow(/low-water/iu);
  });
});
