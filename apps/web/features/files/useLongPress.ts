"use client";

import { type PointerEvent, useRef } from "react";
import { haptic } from "@/lib/haptics";

/** How long a finger rests on an entry before it selects it, and how far it may drift meanwhile. */
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 8;

/**
 * A finger resting on an entry: `onLongPress` fires after half a second without the finger moving,
 * and the click that ends the press is swallowed (`consumeClick` says so), so it does not also open
 * the entry. A mouse never long-presses: it has a right button.
 */
export function useLongPress(onLongPress: () => void) {
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const swallow = useRef(false);

  const cancel = () => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  };

  const handlers = {
    onPointerDown: (e: PointerEvent) => {
      if (e.pointerType === "mouse") return;
      cancel();
      const timer = window.setTimeout(() => {
        press.current = null;
        swallow.current = true;
        haptic("medium");
        onLongPress();
      }, LONG_PRESS_MS);
      press.current = { timer, x: e.clientX, y: e.clientY };
    },
    onPointerMove: (e: PointerEvent) => {
      const p = press.current;
      if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > LONG_PRESS_SLOP) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
  };

  /** Whether this click ends a long press (and should do nothing more). Resets on reading. */
  const consumeClick = () => {
    const was = swallow.current;
    swallow.current = false;
    return was;
  };

  return { handlers, consumeClick };
}
