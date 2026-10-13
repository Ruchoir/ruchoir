"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { onCalendarChanged } from "@/lib/calendarEvents";
import { listCalendars, listOccurrences, type Calendar, type Occurrence } from "@/lib/data/calendar";

/** How long a burst of changes is gathered before the screen reloads once. */
const SETTLE_MS = 250;

/** How many periods' occurrences are kept for the screen's next opening. */
const KEPT_PERIODS = 8;

/**
 * What the screen last showed, for one viewer: opening it again draws that at once and refreshes
 * behind, rather than flashing a loading line and the calendars' column in. Per viewer, so another
 * account signing in on the same tab never sees the previous one's calendars.
 */
let kept: { viewer: string; calendars: Calendar[]; occurrences: Map<string, Occurrence[]> } | null = null;

function keptFor(viewer: string | undefined) {
  return viewer && kept?.viewer === viewer ? kept : null;
}

function periodKey(from: string, to: string, shownKey: string, invitations: boolean): string {
  return `${from}|${to}|${shownKey}|${invitations ? 1 : 0}`;
}

/**
 * What the calendar screen shows: the viewer's calendars, and the occurrences of the period on screen
 * in the calendars they have not hidden, with what they are invited to from calendars they do not see
 * unless they hid that too. Both reload when the realtime connection says a calendar
 * changed (someone else's edit, or this person's on another device).
 */
export function useCalendarData({ from, to }: { from: string; to: string }, invitations = true, viewer?: string) {
  const [calendars, setCalendars] = useState<Calendar[] | null>(() => keptFor(viewer)?.calendars ?? null);
  const [occurrences, setOccurrences] = useState<Occurrence[] | null>(() => {
    const before = keptFor(viewer);
    if (!before) return null;
    const shown = before.calendars.filter((c) => !c.hidden).map((c) => c.id).join(",");
    return before.occurrences.get(periodKey(from, to, shown, invitations)) ?? null;
  });
  const [failed, setFailed] = useState(false);
  const [version, setVersion] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    const stop = onCalendarChanged(() => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(reload, SETTLE_MS);
    });
    return () => {
      stop();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [reload]);

  useEffect(() => {
    const abort = new AbortController();
    listCalendars(abort.signal)
      .then((found) => {
        setCalendars(found);
        setFailed(false);
      })
      .catch((err: unknown) => {
        if ((err as Error)?.name !== "AbortError") setFailed(true);
      });
    return () => abort.abort();
  }, [version]);

  // Kept as they are on screen, with the viewer's own changes (a calendar hidden) in.
  useEffect(() => {
    if (viewer && calendars) kept = { viewer, calendars, occurrences: keptFor(viewer)?.occurrences ?? new Map() };
  }, [viewer, calendars]);

  const shown = calendars?.filter((c) => !c.hidden).map((c) => c.id);
  const shownKey = shown?.join(",");
  useEffect(() => {
    // Not loaded yet, or every calendar hidden: nothing to ask for.
    if (!shownKey) return;
    const abort = new AbortController();
    listOccurrences(from, to, shownKey.split(","), abort.signal, invitations)
      .then((found) => {
        setOccurrences(found);
        setFailed(false);
        const mine = keptFor(viewer);
        if (mine) {
          const key = periodKey(from, to, shownKey, invitations);
          mine.occurrences.delete(key);
          mine.occurrences.set(key, found);
          // The oldest period goes first: a Map keeps its keys in the order they were set.
          if (mine.occurrences.size > KEPT_PERIODS) mine.occurrences.delete(mine.occurrences.keys().next().value!);
        }
      })
      .catch((err: unknown) => {
        if ((err as Error)?.name !== "AbortError") setFailed(true);
      });
    return () => abort.abort();
  }, [from, to, shownKey, version, invitations, viewer]);

  return { calendars, occurrences: shownKey === "" ? [] : occurrences, failed, reload, setCalendars };
}
