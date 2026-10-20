import type { CalendarEvent, Occurrence, RuchoirClient } from "@ruchoir/client";

import { occurrenceOf } from "../../logic/eventForm";

/**
 * An event and the occurrence opened: for a date of a series, that date as itself (a date changed
 * apart has its own title, place and times), found among the occurrences of a day around where it
 * was shown; else drawn from the series.
 */
export async function loadOccurrence(
  api: RuchoirClient,
  eventId: string,
  recurrenceId: string | undefined,
  start: string | undefined,
  signal: AbortSignal,
): Promise<{ event: CalendarEvent; occurrence: Occurrence }> {
  const event = await api.getEvent(eventId, signal);
  if (!recurrenceId) return { event, occurrence: event };
  const at = Date.parse(start ?? recurrenceId);
  const length = Math.max(0, Date.parse(event.end) - Date.parse(event.start));
  const day = 86_400_000;
  const found = await api.listOccurrences(new Date(at - day).toISOString(), new Date(at + length + day).toISOString(), [event.calendarId], signal).catch(
    () => [] as Occurrence[],
  );
  const occurrence = found.find((o) => o.eventId === eventId && o.recurrenceId === recurrenceId);
  return { event, occurrence: occurrence ?? occurrenceOf(event, recurrenceId) };
}
