"use client";

import { useSyncExternalStore } from "react";

/**
 * The three shells the application draws, by the width of the window.
 *
 * - `phone` (below 768px): one screen at a time. Three tabs at the bottom (home, messages,
 *   activity), and everything opened from them (a conversation, a thread, a channel's details)
 *   pushed over them full screen with its own way back.
 * - `tablet` (768 to 1199px): two columns, the space's list and what is open. No rail: the space is
 *   switched from the list's header. Side panels (members, files, a thread) cover the conversation
 *   instead of squeezing it, since there is no room for a third column.
 * - `desktop` (1200px and wider): the rail, the list, the conversation and its side panel.
 *
 * The breakpoints are the content's: below 768 two columns leave the conversation narrower than a
 * phone held upright, and below 1200 a side panel beside the conversation leaves it under 500px.
 */
export type Layout = "phone" | "tablet" | "desktop";

export const PHONE_MAX = 767;
export const TABLET_MAX = 1199;

const PHONE_QUERY = `(max-width: ${PHONE_MAX}px)`;
const TABLET_QUERY = `(max-width: ${TABLET_MAX}px)`;

function subscribe(onChange: () => void): () => void {
  const queries = [window.matchMedia(PHONE_QUERY), window.matchMedia(TABLET_QUERY)];
  for (const q of queries) q.addEventListener("change", onChange);
  return () => {
    for (const q of queries) q.removeEventListener("change", onChange);
  };
}

function current(): Layout {
  if (window.matchMedia(PHONE_QUERY).matches) return "phone";
  if (window.matchMedia(TABLET_QUERY).matches) return "tablet";
  return "desktop";
}

/** The static export's render pass has no window: it draws the desktop, and the client corrects. */
function onServer(): Layout {
  return "desktop";
}

/** Which shell the window calls for, following it as it is resized or turned. */
export function useLayout(): Layout {
  return useSyncExternalStore(subscribe, current, onServer);
}

/**
 * Whether the primary pointer is a finger. Hover does not exist there: a toolbar that appears on
 * hover appears on a tap and stays, and a long press is the gesture that opens a message's actions.
 */
const TOUCH_QUERY = "(hover: none) and (pointer: coarse)";

function subscribeTouch(onChange: () => void): () => void {
  const q = window.matchMedia(TOUCH_QUERY);
  q.addEventListener("change", onChange);
  return () => q.removeEventListener("change", onChange);
}

export function useTouch(): boolean {
  return useSyncExternalStore(
    subscribeTouch,
    () => window.matchMedia(TOUCH_QUERY).matches,
    () => false,
  );
}
