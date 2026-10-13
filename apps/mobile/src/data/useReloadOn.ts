import { useEffect, useRef, useState } from "react";

import { useRealtimeEvent, type RealtimeEvent } from "../realtime/RealtimeProvider";

/**
 * Reload when live events say what is on screen changed, folding a burst (ten messages in a second)
 * into one request a moment after the last of them.
 *
 * Only a new event schedules a reload: `reload` may be a fresh function on every render without
 * scheduling another one (the latest is kept aside and called when the time comes).
 */
export function useReloadOn(matches: (event: RealtimeEvent) => boolean, reload: () => void, delay = 1000): void {
  const [stamp, setStamp] = useState(0);
  const latest = useRef(reload);
  useEffect(() => {
    latest.current = reload;
  });
  useRealtimeEvent((event) => {
    if (matches(event)) setStamp((n) => n + 1);
  });
  useEffect(() => {
    if (stamp === 0) return;
    const timer = setTimeout(() => latest.current(), delay);
    return () => clearTimeout(timer);
  }, [stamp, delay]);
}
