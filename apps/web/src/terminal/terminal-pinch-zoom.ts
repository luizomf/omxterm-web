import { clampTerminalFontSize } from './terminal-font-zoom';

// Pinch zoom scales the font relative to where the gesture started, not by
// per-frame deltas: accumulating deltas drifts when clamping kicks in, while
// (currentDistance / startDistance) stays stable and reversible.

export type PinchGestureStart = {
  /** Distance in px between the two touch points when the gesture began. */
  startDistance: number;
  /** Terminal fontSize when the gesture began. */
  startFontSize: number;
};

type TouchPoint = { clientX: number; clientY: number };

export function touchPairDistance(a: TouchPoint, b: TouchPoint): number {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

/**
 * Returns the clamped font size for the current pinch spread.
 *
 * @example
 * pinchedTerminalFontSize({ startDistance: 100, startFontSize: 16 }, 150); // 24
 * pinchedTerminalFontSize({ startDistance: 100, startFontSize: 16 }, 50); // 8
 */
export function pinchedTerminalFontSize(
  gesture: PinchGestureStart,
  currentDistance: number,
): number {
  // Two touches can report the same coordinates for one frame; a zero start
  // distance would make every later frame jump to the max size.
  if (gesture.startDistance <= 0) {
    return clampTerminalFontSize(gesture.startFontSize);
  }
  const scaled =
    gesture.startFontSize * (currentDistance / gesture.startDistance);
  return clampTerminalFontSize(Math.round(scaled));
}

export type PinchZoomTarget = {
  currentFontSize(): number;
  applyFontSize(next: number): void;
};

/**
 * Turns a two-finger pinch on the terminal surface into fontSize changes.
 * Returns a dispose function that removes the listeners.
 *
 * Listeners run in the capture phase so the gesture never reaches xterm's own
 * touch scrolling; single-finger events pass through untouched, keeping
 * scrollback scroll and selection working. passive:false lets preventDefault
 * stop browser page zoom where touch-action alone is not honored.
 */
export function attachTerminalPinchZoom(
  surface: HTMLElement,
  target: PinchZoomTarget,
): () => void {
  let gesture: PinchGestureStart | null = null;

  const pinchTouches = (event: TouchEvent): [TouchPoint, TouchPoint] | null => {
    if (event.touches.length !== 2) return null;
    const first = event.touches[0];
    const second = event.touches[1];
    return first && second ? [first, second] : null;
  };

  const onTouchStart = (event: TouchEvent) => {
    const touches = pinchTouches(event);
    if (!touches) return;
    event.preventDefault();
    event.stopPropagation();
    gesture = {
      startDistance: touchPairDistance(...touches),
      startFontSize: target.currentFontSize(),
    };
  };

  const onTouchMove = (event: TouchEvent) => {
    const touches = pinchTouches(event);
    if (!gesture || !touches) return;
    event.preventDefault();
    event.stopPropagation();
    target.applyFontSize(
      pinchedTerminalFontSize(gesture, touchPairDistance(...touches)),
    );
  };

  const onTouchEnd = (event: TouchEvent) => {
    if (event.touches.length < 2) gesture = null;
  };

  surface.addEventListener('touchstart', onTouchStart, {
    capture: true,
    passive: false,
  });
  surface.addEventListener('touchmove', onTouchMove, {
    capture: true,
    passive: false,
  });
  surface.addEventListener('touchend', onTouchEnd, true);
  surface.addEventListener('touchcancel', onTouchEnd, true);

  return () => {
    surface.removeEventListener('touchstart', onTouchStart, true);
    surface.removeEventListener('touchmove', onTouchMove, true);
    surface.removeEventListener('touchend', onTouchEnd, true);
    surface.removeEventListener('touchcancel', onTouchEnd, true);
  };
}
