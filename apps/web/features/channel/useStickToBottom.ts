"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Keeps a scrolling feed pinned to its latest content, the way a conversation is read.
 *
 * The rule is the reader's position, not the arrival of content: someone sitting at the bottom is
 * following the conversation and wants to keep following it, while someone who has scrolled up is
 * reading something and must not be yanked away from it. So this tracks whether the feed is at the
 * bottom, and only then follows.
 *
 * Deriving that from the message count alone, which is what this replaces, gets both halves wrong.
 * It scrolls a reader who had gone back through the history, and it misses everything that changes
 * height without changing the count: an image or an attachment that finishes loading after the
 * render, an edit, a reaction that wraps onto a new line, the composer's typing indicator growing
 * and shrinking the feed's own padding. A `ResizeObserver` on the content is what catches those,
 * because it fires after layout rather than during the commit that caused it.
 *
 * `resetKey` is the conversation: changing it lands at the latest message and starts following
 * again, which is how opening a channel should behave whatever was on screen before.
 *
 * Returns the ref to put on the scrolling element, whether the feed is currently being followed,
 * and a way to go back to the bottom, for the affordance offered when it is not.
 */
export function useStickToBottom<T extends HTMLElement>(resetKey: string) {
  const ref = useRef<T>(null);
  const [following, setFollowing] = useState(true);
  // Read by the observers, which must not be re-subscribed every time the reader scrolls.
  const followingRef = useRef(true);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = ref.current;
    if (!el) return;
    followingRef.current = true;
    setFollowing(true);
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  // A margin, because "at the bottom" is never exact: a fractional device pixel ratio leaves a
  // sub-pixel remainder, and a reader who is a line short of the end is still reading the end.
  const THRESHOLD = 64;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      const next = distance <= THRESHOLD;
      if (next === followingRef.current) return;
      followingRef.current = next;
      setFollowing(next);
    };

    // Content that grew while we were following: stay at the end. This covers the ordinary case of
    // a new message as well as every late reflow, and it runs after layout, so `scrollHeight` is
    // the height that was actually painted.
    const observer = new ResizeObserver(() => {
      if (followingRef.current) el.scrollTop = el.scrollHeight;
      else measure();
    });
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);

    el.addEventListener("scroll", measure, { passive: true });
    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", measure);
    };
  }, []);

  // Opening a conversation lands on its latest message. Without the reset the previous one's
  // position would be inherited, and a reader who had scrolled up in one channel would arrive
  // mid-history in the next.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    followingRef.current = true;
    setFollowing(true);
    el.scrollTop = el.scrollHeight;
  }, [resetKey]);

  return { ref, following, scrollToBottom };
}
