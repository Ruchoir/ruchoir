import { useEffect, useState } from "react";

import { useRealtimeEvent, type RealtimeEvent } from "../realtime/RealtimeProvider";

/**
 * Reload when live events say what is on screen changed, folding a burst (ten messages in a second)
 * into one request a moment after the last of them.
 */
export function useReloadOn(matches: (event: RealtimeEvent) => boolean, reload: () => void, delay = 1000): void {
  const [stamp, setStamp] = useState(0);
  useRealtimeEvent((event) => {
    if (matches(event)) setStamp((n) => n + 1);
  });
  useEffect(() => {
    if (stamp === 0) return;
    const timer = setTimeout(reload, delay);
    return () => clearTimeout(timer);
  }, [stamp, reload, delay]);
}
