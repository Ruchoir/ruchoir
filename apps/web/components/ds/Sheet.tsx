import { useEffect, useRef, type ReactNode } from "react";
import { haptic } from "@/lib/haptics";
import { Icon, type IconName } from "./Icon";

// Fingers on the glass, counted page-wide (capture, so nothing can hide a touch from it).
let fingersDown = 0;
if (typeof window !== "undefined") {
  const count = (e: TouchEvent) => {
    fingersDown = e.touches.length;
  };
  window.addEventListener("touchstart", count, { capture: true, passive: true });
  window.addEventListener("touchend", count, { capture: true, passive: true });
  window.addEventListener("touchcancel", count, { capture: true, passive: true });
}

export type SheetProps = {
  open?: boolean;
  /** Accessible name of the sheet. Drawn as its heading when `heading` is set. */
  label: string;
  /** Draw the label as a visible heading at the top of the sheet. */
  heading?: boolean;
  onClose: () => void;
  children?: ReactNode;
  className?: string;
};

/**
 * A sheet rising from the bottom of the screen: the touch form of a menu. Used where a finger is the
 * pointer (a message's actions, the space switcher, the account menu on a phone), because a popover
 * anchored to a small target is hard to reach and easy to dismiss by accident.
 *
 * Closes on the scrim, on Escape, from its own rows, and when a finger drags it down past a third of its
 * height (or flicks it down). Focus moves into it when it opens and goes
 * back where it was when it closes, so a keyboard or a screen reader is never left behind it.
 */
export function Sheet({ open = true, label, heading = false, onClose, children, className = "" }: SheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Held in a ref so a parent passing a fresh function on every render does not re-run the effect,
  // which would pull the focus back to the sheet each time.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      before?.focus?.();
    };
  }, [open]);

  // Drag to dismiss. Touch events rather than pointer events: the panel scrolls, and the browser
  // cancels a pointer the moment it takes over a pan, whereas a non-passive touchmove can claim it.
  // A drag starts only from the top of the scroll, so a long sheet still scrolls up and down as usual.
  useEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) return;
    let startY = 0;
    let startAt = 0;
    let dy = 0;
    let dragging = false;
    let armed = false;
    const setOffset = (y: number, animate: boolean) => {
      panel.style.transition = animate ? "transform 200ms var(--ease-out)" : "none";
      panel.style.transform = y ? `translateY(${y}px)` : "";
    };
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      startY = e.touches[0].clientY;
      startAt = e.timeStamp;
      dy = 0;
      dragging = false;
      armed = panel.scrollTop <= 0;
    };
    const onMove = (e: TouchEvent) => {
      if (!armed) return;
      const d = e.touches[0].clientY - startY;
      if (!dragging) {
        if (d < 6) {
          if (d < -6) armed = false;
          return;
        }
        dragging = true;
      }
      e.preventDefault();
      dy = Math.max(0, d);
      setOffset(dy, false);
    };
    const onEnd = (e: TouchEvent) => {
      if (!dragging) return;
      dragging = false;
      const speed = dy / Math.max(1, e.timeStamp - startAt);
      if (dy > panel.offsetHeight / 3 || (dy > 40 && speed > 0.6)) {
        haptic();
        setOffset(panel.offsetHeight + 40, true);
        window.setTimeout(() => closeRef.current(), 180);
      } else {
        setOffset(0, true);
      }
    };
    panel.addEventListener("touchstart", onStart, { passive: true });
    panel.addEventListener("touchmove", onMove, { passive: false });
    panel.addEventListener("touchend", onEnd);
    panel.addEventListener("touchcancel", onEnd);
    return () => {
      panel.removeEventListener("touchstart", onStart);
      panel.removeEventListener("touchmove", onMove);
      panel.removeEventListener("touchend", onEnd);
      panel.removeEventListener("touchcancel", onEnd);
      setOffset(0, false);
    };
  }, [open]);

  // A sheet opened by a held press rises under a finger still on the glass: the row beneath it would
  // light up as pressed, and lifting would press it. Rows ignore touches until that finger lifts.
  useEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel || fingersDown === 0) return;
    panel.style.pointerEvents = "none";
    const lift = () => {
      if (fingersDown !== 0) return;
      panel.style.pointerEvents = "";
      // iOS plays a tap only inside a touch's own end, not from the hold timer that opened the sheet,
      // so there it is felt as the finger lifts. Android already vibrated when the hold registered.
      if (typeof navigator.vibrate !== "function") haptic();
    };
    window.addEventListener("touchend", lift);
    window.addEventListener("touchcancel", lift);
    return () => {
      window.removeEventListener("touchend", lift);
      window.removeEventListener("touchcancel", lift);
      panel.style.pointerEvents = "";
    };
  }, [open]);

  if (!open) return null;
  return (
    <div
      className="wc-sheet__scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} className={`wc-sheet ${className}`}>
        <span className="wc-sheet__handle" aria-hidden />
        {heading ? <div className="wc-sheet__title">{label}</div> : null}
        {children}
      </div>
    </div>
  );
}

/** A group of rows, set apart from the next (the destructive ones go in a group of their own). */
export function SheetGroup({ children }: { children: ReactNode }) {
  return <div className="wc-sheet__group">{children}</div>;
}

export type SheetItemProps = {
  icon?: IconName;
  /** Something drawn in place of the icon: an avatar, a presence dot. */
  leading?: ReactNode;
  label: ReactNode;
  /** A second line, quieter. */
  detail?: ReactNode;
  /** Drawn at the end of the row: a badge, a check. */
  trailing?: ReactNode;
  danger?: boolean;
  selected?: boolean;
  onClick: () => void;
};

/** One row of a sheet: a full-width target, 48px tall, for a thumb. */
export function SheetItem({ icon, leading, label, detail, trailing, danger, selected, onClick }: SheetItemProps) {
  return (
    <button
      type="button"
      className={`wc-sheet__item${danger ? " wc-sheet__item--danger" : ""}`}
      aria-current={selected || undefined}
      onClick={onClick}
    >
      {leading ?? (icon ? <Icon name={icon} size={18} /> : null)}
      <span className="wc-sheet__label">
        <span>{label}</span>
        {detail ? <span className="wc-sheet__detail">{detail}</span> : null}
      </span>
      {trailing}
    </button>
  );
}
