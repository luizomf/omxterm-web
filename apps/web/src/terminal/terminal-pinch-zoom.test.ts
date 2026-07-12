import { fireEvent } from '@testing-library/dom';
import { describe, expect, test, vi } from 'vitest';
import {
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
} from './terminal-font-zoom';
import {
  attachTerminalPinchZoom,
  pinchedTerminalFontSize,
  touchPairDistance,
} from './terminal-pinch-zoom';

describe('touchPairDistance', () => {
  test('measures the straight-line distance between two touch points', () => {
    expect(
      touchPairDistance({ clientX: 0, clientY: 0 }, { clientX: 3, clientY: 4 }),
    ).toBe(5);
  });

  test('is zero when both touches share the same point', () => {
    const point = { clientX: 10, clientY: 20 };
    expect(touchPairDistance(point, point)).toBe(0);
  });
});

describe('pinchedTerminalFontSize', () => {
  test('grows the font when the fingers spread apart', () => {
    expect(
      pinchedTerminalFontSize({ startDistance: 100, startFontSize: 16 }, 150),
    ).toBe(24);
  });

  test('shrinks the font when the fingers come together', () => {
    expect(
      pinchedTerminalFontSize({ startDistance: 100, startFontSize: 16 }, 75),
    ).toBe(12);
  });

  test('returns the start size when the spread has not changed', () => {
    expect(
      pinchedTerminalFontSize({ startDistance: 120, startFontSize: 18 }, 120),
    ).toBe(18);
  });

  test('clamps to the shared zoom bounds on extreme pinches', () => {
    const gesture = { startDistance: 100, startFontSize: 16 };
    expect(pinchedTerminalFontSize(gesture, 10_000)).toBe(
      MAX_TERMINAL_FONT_SIZE,
    );
    expect(pinchedTerminalFontSize(gesture, 1)).toBe(MIN_TERMINAL_FONT_SIZE);
  });

  test('keeps the start size when the gesture began with a zero distance', () => {
    expect(
      pinchedTerminalFontSize({ startDistance: 0, startFontSize: 16 }, 200),
    ).toBe(16);
  });

  test('rounds the scaled size to a whole pixel value', () => {
    expect(
      pinchedTerminalFontSize({ startDistance: 100, startFontSize: 16 }, 110),
    ).toBe(18); // 17.6 rounds up
  });
});

describe('attachTerminalPinchZoom', () => {
  const touches = (spread: number) => [
    { clientX: 0, clientY: 0 },
    { clientX: spread, clientY: 0 },
  ];

  function pinchTarget(startFontSize = 16) {
    let fontSize = startFontSize;
    return {
      currentFontSize: () => fontSize,
      applyFontSize: vi.fn((next: number) => {
        fontSize = next;
      }),
    };
  }

  test('a two-finger spread grows the font relative to the gesture start', () => {
    const surface = document.createElement('div');
    const target = pinchTarget(16);
    attachTerminalPinchZoom(surface, target);

    fireEvent.touchStart(surface, { touches: touches(100) });
    fireEvent.touchMove(surface, { touches: touches(150) });

    expect(target.applyFontSize).toHaveBeenLastCalledWith(24);
  });

  test('single-finger touches never change the font size', () => {
    const surface = document.createElement('div');
    const target = pinchTarget();
    attachTerminalPinchZoom(surface, target);

    fireEvent.touchStart(surface, { touches: touches(100).slice(0, 1) });
    fireEvent.touchMove(surface, { touches: touches(150).slice(0, 1) });

    expect(target.applyFontSize).not.toHaveBeenCalled();
  });

  test('a move without a preceding two-finger start is ignored', () => {
    const surface = document.createElement('div');
    const target = pinchTarget();
    attachTerminalPinchZoom(surface, target);

    fireEvent.touchMove(surface, { touches: touches(150) });

    expect(target.applyFontSize).not.toHaveBeenCalled();
  });

  test('lifting a finger ends the gesture and the next pinch starts fresh', () => {
    const surface = document.createElement('div');
    const target = pinchTarget(16);
    attachTerminalPinchZoom(surface, target);

    fireEvent.touchStart(surface, { touches: touches(100) });
    fireEvent.touchMove(surface, { touches: touches(200) }); // 16 -> 32
    fireEvent.touchEnd(surface, { touches: touches(0).slice(0, 1) });

    // New gesture must scale from the current 32, not the original 16.
    fireEvent.touchStart(surface, { touches: touches(100) });
    fireEvent.touchMove(surface, { touches: touches(50) });

    expect(target.applyFontSize).toHaveBeenLastCalledWith(16);
  });

  test('dispose removes the listeners', () => {
    const surface = document.createElement('div');
    const target = pinchTarget();
    const dispose = attachTerminalPinchZoom(surface, target);
    dispose();

    fireEvent.touchStart(surface, { touches: touches(100) });
    fireEvent.touchMove(surface, { touches: touches(150) });

    expect(target.applyFontSize).not.toHaveBeenCalled();
  });
});
