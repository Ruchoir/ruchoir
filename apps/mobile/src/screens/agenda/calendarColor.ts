import type { CalendarColor } from "@ruchoir/client";

import type { Palette } from "../../theme/tokens";

/** A calendar's colour on the palette: one of the pastels, or the reader's own accent. */
export function calendarColor(color: CalendarColor | undefined, c: Palette): string {
  if (!color || color === "accent") return c.acc;
  return c[color];
}
