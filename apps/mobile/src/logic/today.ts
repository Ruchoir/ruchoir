/**
 * What "To look at now" shows (mockup 09), at most one card of each kind, in this order: the latest
 * unread message that names or answers the reader in this space, the next event of today (one that
 * has begun and not ended counts), and the newest file of the last 48 hours.
 */
import type { ApiNotification, Occurrence, SpaceFile } from "@ruchoir/client";

import { dayKey } from "./format.ts";

export type NowCard =
  | { kind: "mention"; notification: ApiNotification }
  | { kind: "event"; occurrence: Occurrence }
  | { kind: "file"; file: SpaceFile };

/** The kinds that are someone talking to the reader, as opposed to the calendar's own notices. */
const SPOKEN = new Set<ApiNotification["kind"]>(["mention", "reply", "dm", "broadcast"]);
const NEW_FILE_MS = 48 * 3600 * 1000;

export function pickNowCards(input: {
  notifications: ApiNotification[];
  occurrences: Occurrence[];
  recentFiles: SpaceFile[];
  now: Date;
  spaceId: string;
  timeZone: string;
}): NowCard[] {
  const { now, spaceId, timeZone } = input;
  const cards: NowCard[] = [];

  const mention = input.notifications
    .filter((n) => !n.read && n.spaceId === spaceId && SPOKEN.has(n.kind))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (mention) cards.push({ kind: "mention", notification: mention });

  const today = dayKey(now, timeZone);
  const next = input.occurrences
    .filter((o) => !o.allDay && dayKey(o.start, timeZone) === today && Date.parse(o.end) > now.getTime())
    .sort((a, b) => a.start.localeCompare(b.start))[0];
  if (next) cards.push({ kind: "event", occurrence: next });

  const fresh = input.recentFiles
    .filter((f) => f.kind !== "folder" && f.updatedAt && now.getTime() - Date.parse(f.updatedAt) < NEW_FILE_MS)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (fresh) cards.push({ kind: "file", file: fresh });

  return cards;
}
