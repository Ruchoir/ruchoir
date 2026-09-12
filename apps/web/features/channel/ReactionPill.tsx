"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";
import { Tooltip } from "@/components/ds";
import { Emoji } from "../app/Emoji";
import { useTranslation } from "@/lib/i18n";

const PLAY_MS = 3000;

/**
 * A single reaction pill. Its emoji plays the animation for 3s the first time the pill scrolls into
 * view (message seen), then settles to the static sprite. While the pill is hovered the animation
 * plays continuously, and it freezes again on mouse leave. Hover covers the whole pill (button), not
 * just the glyph.
 *
 * Animation is driven by toggling `Emoji`'s `animated` flag: that swaps the rendered node (animated
 * `<img>` vs static `<svg><use>`), and mounting a fresh `<img>` restarts the APNG from frame 0, so a
 * flip is a replay. Emojis without an animated asset (or with the setting off) just stay static.
 */
export function ReactionPill({
  emoji,
  count,
  mine,
  users,
  style,
  onClick,
}: {
  emoji: string;
  count: number;
  mine?: boolean;
  /** Display names of the reactors, shown in the hover tooltip. */
  users?: string[];
  style: CSSProperties;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const [playing, setPlaying] = useState(false);
  const [hovered, setHovered] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const timerRef = useRef<number | null>(null);

  const clearTimer = () => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  // Play once for 3s when the pill first becomes visible (message seen). Fall back to an immediate
  // play when IntersectionObserver is unavailable.
  useEffect(() => {
    const el = buttonRef.current;
    const playOnce = () => {
      setPlaying(true);
      clearTimer();
      timerRef.current = window.setTimeout(() => setPlaying(false), PLAY_MS);
    };
    if (!el || typeof IntersectionObserver === "undefined") {
      playOnce();
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          playOnce();
          observer.disconnect();
        }
      },
      { threshold: 0.5 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Clear any pending timer on unmount.
  useEffect(() => () => clearTimer(), []);

  const onEnter = () => {
    clearTimer(); // hover holds the animation open, so cancel the auto-stop
    setHovered(true);
  };
  const onLeave = () => setHovered(false);

  // Plural handled by the dictionary: French turns at two, Polish has three forms, and a manual
  // `s` would have been right in exactly one language.
  const reactors = users && users.length > 0 ? users.join(", ") : t("message.reactionCount", { count });

  return (
    <Tooltip label={reactors} side="top">
      <button
        ref={buttonRef}
        type="button"
        className="wc-react"
        style={style}
        onClick={onClick}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        aria-pressed={mine}
        aria-label={t("message.reactionCount", { emoji, count })}
      >
        <Emoji emoji={emoji} size={16} animated={hovered || playing} />
        {count}
      </button>
    </Tooltip>
  );
}
