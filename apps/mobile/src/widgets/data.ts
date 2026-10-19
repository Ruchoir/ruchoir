/**
 * What the Android widgets show, computed from the instance's answers (step 6e): the next events and
 * the unread count. The iPhone's widgets do the same in Swift (`targets/widgets`). Free of React
 * Native so Node tests it.
 */

/** An occurrence as `GET /api/v1/calendar/occurrences` returns it, the fields used here. */
export type WireEvent = { title: string; location?: string | null; all_day: boolean; start: string; end: string };

/** The events not over yet at `now`, soonest first, at most `limit`. */
export function upcoming(events: WireEvent[], now: Date, limit: number): WireEvent[] {
  return events
    .filter((e) => new Date(e.end).getTime() > now.getTime())
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
    .slice(0, limit);
}

export type StartsIn = { kind: "now" } | { kind: "minutes"; n: number } | { kind: "hours"; n: number } | { kind: "later" };

/** "now", "in 20 min", "in 2 h", or later than that (the day and time say it then). */
export function startsIn(start: Date, now: Date): StartsIn {
  const minutes = Math.round((start.getTime() - now.getTime()) / 60_000);
  if (minutes <= 0) return { kind: "now" };
  if (minutes < 60) return { kind: "minutes", n: minutes };
  if (minutes < 24 * 60) return { kind: "hours", n: Math.round(minutes / 60) };
  return { kind: "later" };
}

/** The unread messages of every space, as `GET /api/v1/me/spaces` counts them. */
export function unreadTotal(spaces: { unread?: number }[]): number {
  return spaces.reduce((sum, space) => sum + (space.unread ?? 0), 0);
}

/** The app's palette in a widget: the theme chosen in the app ("violet-dark"), as the mockups ask. */
export type WidgetPalette = {
  dark: boolean;
  acc: `#${string}`;
  surface: `#${string}`;
  strong: `#${string}`;
  body: `#${string}`;
  muted: `#${string}`;
  line: `#${string}`;
  onPastel: `#${string}`;
  sky: `#${string}`;
  mint: `#${string}`;
  violet: `#${string}`;
  sun: `#${string}`;
  pink: `#${string}`;
  peach: `#${string}`;
};

const PASTELS = { sky: "#8fd0ff", mint: "#6fe0c2", violet: "#c9a8ff", pink: "#f5b0f0", peach: "#ffb3ba", sun: "#ffd84d" } as const;

/** The palette of `theme` ("mint", "mint-dark"), or of the phone's own day or night without one. */
export function widgetPalette(theme: string | null, systemDark: boolean): WidgetPalette {
  const [accent, night] = (theme ?? "").split("-");
  const dark = theme ? night === "dark" : systemDark;
  const acc = PASTELS[(accent in PASTELS ? accent : "sky") as keyof typeof PASTELS];
  return {
    dark,
    acc,
    ...PASTELS,
    onPastel: "#15171c",
    ...(dark
      ? { surface: "#1d2027", strong: "#f6f7f9", body: "#dfe2e7", muted: "#a7adb8", line: "#3f4450" }
      : { surface: "#fdfdfe", strong: "#15171c", body: "#2e323a", muted: "#5a6070", line: "#cfd3da" }),
  };
}

/** `color-mix(in srgb, a weight, b)` on two hex colours. */
export function mixHex(a: string, b: string, weight: number): `#${string}` {
  const parse = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [x, y] = [parse(a), parse(b)];
  return `#${x.map((v, i) => Math.round(v * weight + y[i] * (1 - weight)).toString(16).padStart(2, "0")).join("")}`;
}

/** A conversation's latest message as `GET /spaces/{id}/channels` and `/dms` say it. */
export type WireLast = { excerpt: string; mine: boolean; created_at: string; author?: string; system_event?: string };

/** "Léa : the words", "Vous : the words", or a notice as it reads. */
export function previewOf(last: WireLast | undefined, you: string, said: (who: string, text: string) => string): string {
  if (!last) return "";
  if (last.system_event) return last.excerpt;
  if (last.mine) return said(you, last.excerpt);
  const first = last.author?.split(" ")[0];
  return first ? said(first, last.excerpt) : last.excerpt;
}

/** "LM" for Léa Martin, "É" for Équipe. */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
}
