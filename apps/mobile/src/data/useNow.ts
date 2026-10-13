import { useEffect, useState } from "react";

/** The current time, moving on every `everyMs`, so "in 2 h" and "today" stay true on an open screen. */
export function useNow(everyMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}
