"use client";

import { type CSSProperties, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { haptic } from "@/lib/haptics";

/**
 * Reordering a vertical list by dragging, with the pointer (mouse, finger or pen) rather than the
 * browser's drag and drop. The HTML5 one drew a ghost of the item, only knew the slot under the
 * pointer (so nothing could land after the last one), and does not exist on a touch screen. Here the
 * item follows the pointer and the others slide aside to show where it will land.
 *
 * `threshold` is how far the pointer moves before a press becomes a drag: a mouse press that stays
 * put is still a click. A drag handle for a finger passes 0, since pressing it means moving.
 */
export function useDragReorder({ count, onMove, threshold = 5 }: { count: number; onMove: (from: number, to: number) => void; threshold?: number }) {
  const items = useRef<(HTMLElement | null)[]>([]);
  const [drag, setDrag] = useState<{ from: number; dy: number; step: number } | null>(null);
  const moveRef = useRef(onMove);
  useEffect(() => {
    moveRef.current = onMove;
  });

  const clampTo = (from: number, dy: number, step: number) => Math.max(0, Math.min(count - 1, from + Math.round(dy / step)));

  const start = (index: number) => (e: ReactPointerEvent) => {
    if (e.button !== 0 || count < 2) return;
    const startY = e.clientY;
    const startX = e.clientX;
    let active = false;
    let step = 0;
    let last = index;
    let dy = 0;

    const onPointerMove = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      dy = ev.clientY - startY;
      if (!active) {
        if (Math.hypot(ev.clientX - startX, dy) < threshold) return;
        active = true;
        // The distance from one item to the next, gap included, so a list with spacing still lines up.
        const a = items.current[0]?.getBoundingClientRect();
        const b = items.current[1]?.getBoundingClientRect();
        step = a && b ? b.top - a.top : (items.current[index]?.getBoundingClientRect().height ?? 40);
      }
      ev.preventDefault();
      const to = clampTo(index, dy, step);
      if (to !== last) {
        last = to;
        haptic();
      }
      setDrag({ from: index, dy, step });
    };
    const finish = (commit: boolean) => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey);
      if (!active) return;
      setDrag(null);
      // Letting go ends a drag, not a click: the item under the pointer must not also open.
      const swallow = (ev: MouseEvent) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      window.addEventListener("click", swallow, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
      const to = clampTo(index, dy, step);
      if (commit && to !== index) moveRef.current(index, to);
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId === e.pointerId) finish(true);
    };
    const onCancel = (ev: PointerEvent) => {
      if (ev.pointerId === e.pointerId) finish(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") finish(false);
    };
    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey);
  };

  /** Where item `index` is drawn while something is being dragged. */
  const itemStyle = (index: number): CSSProperties | undefined => {
    if (!drag) return undefined;
    const { from, dy, step } = drag;
    if (index === from) return { transform: `translateY(${dy}px)`, zIndex: 2, position: "relative", transition: "none", cursor: "grabbing" };
    const to = clampTo(from, dy, step);
    const shift = from < index && index <= to ? -step : to <= index && index < from ? step : 0;
    return { transform: shift ? `translateY(${shift}px)` : undefined, transition: "transform 150ms var(--ease-out)" };
  };

  return {
    /** Put on each item's outer element, so the step between items can be measured. */
    itemRef: (index: number) => (el: HTMLElement | null) => {
      items.current[index] = el;
    },
    /** Put on what is grabbed: the whole item, or a handle in it. */
    onPointerDown: start,
    itemStyle,
    dragging: drag !== null,
  };
}
