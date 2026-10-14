import type { Calendar } from "@ruchoir/client";

/**
 * How a calendar is named on a line, as the web's picker names it: its name, and under it whose it
 * is (someone's shared calendar) or its space (when the name does not already say it).
 */
export function calendarLabel(calendar: Calendar, spaces: readonly { id: string; name: string }[]): { main: string; sub?: string } {
  if (calendar.shareLevel) return { main: calendar.name, sub: calendar.ownerName };
  const space = spaces.find((s) => s.id === calendar.spaceId)?.name;
  return { main: calendar.name, sub: space && space !== calendar.name ? space : undefined };
}
