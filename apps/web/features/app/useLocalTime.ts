"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "@/lib/i18n";
import { asLocale } from "@/lib/i18n/current";

/**
 * Someone's current local time, kept current while it is on screen.
 *
 * It used to be a string computed once, when their profile was fetched, and then left there: a
 * profile open for twenty minutes showed a time twenty minutes wrong, which is worse than showing
 * none, because it is precise. Time is not a property of a profile; it is derived from a timezone,
 * which is.
 *
 * The tick is aligned to the next minute boundary rather than set to every sixty seconds, so the
 * display changes when the minute changes instead of drifting to some arbitrary offset inside it.
 *
 * `undefined` for an account that has no timezone: nothing is the right answer when nothing is
 * known, and the caller renders no row at all.
 */
export function useLocalTime(timezone?: string): string | undefined {
  const { i18n } = useTranslation();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!timezone) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      setNow(Date.now());
      // Until the start of the next minute, plus a hair: a timer that fires a few milliseconds early
      // would set the same minute twice and then run at double rate for the rest of the hour.
      timer = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
    };
    timer = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
    return () => clearTimeout(timer);
  }, [timezone]);

  if (!timezone) return undefined;
  try {
    return new Intl.DateTimeFormat(asLocale(i18n.language), {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: timezone,
    }).format(now);
  } catch {
    // A timezone the browser does not know: the row is dropped rather than shown in this browser's
    // own time, which would be someone else's hour presented as theirs.
    return undefined;
  }
}
