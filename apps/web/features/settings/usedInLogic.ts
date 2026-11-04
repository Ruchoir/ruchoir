/**
 * The places that name a group or a role in a rule, as the refusal to delete it lists them (frame 15).
 * The API puts the places the viewer cannot open last, with only their kind; this keeps that order
 * whatever the answer's.
 */

type UsedInLike = { kind: "channel" | "file" | "calendar"; id?: string; name?: string; hidden: boolean };

export type UsedInRow = { kind: UsedInLike["kind"]; id?: string; label?: string; hidden: boolean; kindKey: string };

/** The words for a kind of place: channels and calendars are named elsewhere already. */
const KIND_KEY = { channel: "calendar.channel", file: "access.usedIn.file", calendar: "calendar.title" } as const;

export function usedInRows(used: UsedInLike[]): UsedInRow[] {
  const rows = used.map((place): UsedInRow => ({
    kind: place.kind,
    id: place.hidden ? undefined : place.id,
    label: place.hidden ? undefined : place.kind === "channel" && place.name ? `#${place.name}` : place.name,
    hidden: place.hidden,
    kindKey: KIND_KEY[place.kind],
  }));
  return [...rows.filter((r) => !r.hidden), ...rows.filter((r) => r.hidden)];
}
