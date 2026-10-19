import type { Calendar } from "@ruchoir/client";

/**
 * How a calendar is named on a line, as the web's picker names it: its name, and under it whose it
 * is (someone's shared calendar) or its space (when the name does not already say it).
 */
export function calendarLabel(
  calendar: Calendar,
  spaces: readonly { id: string; name: string }[],
  personal?: string,
): { main: string; sub?: string } {
  if (calendar.shareLevel) return { main: calendar.name, sub: calendar.ownerName };
  const name = calendarName(calendar, personal);
  const space = spaces.find((s) => s.id === calendar.spaceId)?.name;
  return { main: name, sub: space && space !== name ? space : undefined };
}

/** The names the instance gives a person's own calendar, in each language, when it creates it. */
const PERSONAL_NAMES = new Set(["Personnel", "Personal", "Persönlich", "Personale", "Osobisty"]);

/**
 * A calendar's name, the person's own calendar's in the language on screen (`personal`): the
 * instance names it once, in the language of the day it was made, and "Personnel" stayed French
 * for someone who reads German since. A name its owner chose is kept.
 */
export function calendarName(calendar: Pick<Calendar, "name" | "spaceId" | "shareLevel">, personal?: string): string {
  if (personal && !calendar.spaceId && !calendar.shareLevel && PERSONAL_NAMES.has(calendar.name)) return personal;
  return calendar.name;
}
