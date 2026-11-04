/**
 * When the person last touched the screen. A preview ends after a while without activity; the
 * server counts every request, a poll included, so the phone keeps its own count of what a person
 * did: a touch anywhere in the app.
 */
let lastTouchAt = Date.now();

/** Note a touch (called from the root view's responder capture; it never claims the touch). */
export function touch(): void {
  lastTouchAt = Date.now();
}

export function lastTouch(): number {
  return lastTouchAt;
}

/** The handler for `onStartShouldSetResponderCapture`: notes the touch, claims nothing. */
export function noteTouch(): false {
  touch();
  return false;
}
