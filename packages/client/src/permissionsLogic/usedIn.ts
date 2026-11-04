/**
 * The places that name a group or a role in a rule, as the refusal to delete it lists them (frame 15):
 * where, at what level, and how to open it. The API puts the places the viewer cannot open last, with
 * only their kind; this keeps that order whatever the answer's.
 */
import { levelLabelKey } from "./access.ts";

type UsedInLike = {
  kind: "channel" | "file" | "calendar";
  id?: string;
  name?: string;
  hidden: boolean;
  level?: "none" | "read" | "contribute" | "manage" | "custom";
  parentId?: string;
};

/** Where a row leads: a channel, the files at a folder (the root without one), or the calendar. */
export type Place = { type: "channel"; id: string } | { type: "files"; folderId: string | undefined } | { type: "calendar" };

export type UsedInRow = {
  kind: UsedInLike["kind"];
  id?: string;
  label?: string;
  hidden: boolean;
  kindKey: string;
  /** The dictionary key of the level, in the words of that kind of resource. */
  levelKey?: string;
  open?: Place;
};

/** The words for a kind of place: channels and calendars are named elsewhere already. */
const KIND_KEY = { channel: "calendar.channel", file: "access.usedIn.file", calendar: "calendar.title" } as const;

/**
 * A file and a folder are both `file` on the wire. The files view opens at a folder, so a place opens
 * at its parent (which shows it) or at the root when it sits at the top.
 */
function placeOf(place: UsedInLike): Place | undefined {
  if (place.hidden || !place.id) return undefined;
  if (place.kind === "channel") return { type: "channel", id: place.id };
  if (place.kind === "calendar") return { type: "calendar" };
  return { type: "files", folderId: place.parentId };
}

export function usedInRows(used: UsedInLike[]): UsedInRow[] {
  const rows = used.map((place): UsedInRow => ({
    kind: place.kind,
    id: place.hidden ? undefined : place.id,
    label: place.hidden ? undefined : place.kind === "channel" && place.name ? `#${place.name}` : place.name,
    hidden: place.hidden,
    kindKey: KIND_KEY[place.kind],
    levelKey: place.hidden || !place.level ? undefined : levelLabelKey(place.kind, place.level),
    open: placeOf(place),
  }));
  return [...rows.filter((r) => !r.hidden), ...rows.filter((r) => r.hidden)];
}
