/** The instance administrator's list of licences: one line per space, soonest end first. */

import type { AdminLicence, Channel, Workspace } from "../types.ts";
import { daysLeftBanner } from "./audit.ts";
import { daysLeft } from "./guests.ts";

export type { AdminLicence };

/** `unreadable`: the licence could not be read (invalid edition, or an end date that is empty or not a date): no date is shown and `daysLeft` is NaN. */
export type LicenceRow = AdminLicence & { daysLeft: number; frozen: boolean; soon: boolean; unreadable: boolean };

/** Days under which the owners are warned by mail (30, 7, 1). */
const LICENCE_SOON_DAYS = 30;

/** The rows sorted by soonest expiry (an expired one first, an unreadable one last), with the days left counted in `zone`. */
export function licenceRows(list: AdminLicence[], now: Date, zone: string): LicenceRow[] {
  const end = (l: AdminLicence) => (l.validUntil ? Date.parse(l.validUntil) : NaN);
  return list
    .map((l) => {
      const dated = !Number.isNaN(end(l));
      const unreadable = !dated || l.edition === "invalid";
      const days = dated ? daysLeft(l.validUntil, now, zone) : NaN;
      const frozen = l.edition === "frozen";
      return { ...l, daysLeft: days, frozen, unreadable, soon: !frozen && l.edition === "enterprise" && days <= LICENCE_SOON_DAYS };
    })
    .sort((a, b) => {
      const ka = Number.isNaN(end(a)) ? Infinity : end(a);
      const kb = Number.isNaN(end(b)) ? Infinity : end(b);
      return ka === kb ? 0 : ka < kb ? -1 : 1;
    });
}

/**
 * A space already held, with what a re-read of the space list says about the caller's rights: the
 * role, the permissions, the edition and licence, the end of a guest's access and the preview. The
 * counters and the shared settings stay what this client holds (they move by their own events).
 */
export function applyRights(held: Workspace, fresh: Workspace): Workspace {
  return {
    ...held,
    role: fresh.role,
    myPermissions: fresh.myPermissions,
    edition: fresh.edition,
    licence: fresh.licence,
    expiresAt: fresh.expiresAt,
    preview: fresh.preview,
  };
}

/**
 * What the space settings tell the owner about the licence, outside the Licence screen: the last
 * 30 days (sharper in the last week) and the frozen state. Nothing for anyone else, who cannot act on it.
 */
export function spaceLicenceBanner(space: {
  role: string;
  edition: "community" | "enterprise" | "frozen";
  licence?: { validUntil?: string; expiresInDays: number };
}, now: Date, zone: string): { kind: "ends"; tone: "warning" | "danger"; days: number } | { kind: "frozen" } | null {
  if (space.role !== "owner") return null;
  if (space.edition === "frozen") return { kind: "frozen" };
  const ends = daysLeftBanner(space.licence, space.edition, now, zone);
  return ends ? { kind: "ends", ...ends } : null;
}

/**
 * The channel list read again after a rights change, merged into the one this client holds: the
 * server's set, order and rights (a channel the person gained appears, one they lost goes), while
 * what only this client knows right now stays (favourite, unread count, last message: they move
 * ahead of the server through live events and optimistic edits).
 */
export function applyChannelRights(held: Channel[], fresh: Channel[]): Channel[] {
  const mine = new Map(held.map((c) => [c.id, c] as const));
  return fresh.map((f) => {
    const h = mine.get(f.id);
    if (!h) return f;
    return { ...f, fav: h.fav, unread: h.unread, ...(h.lastMessage ? { lastMessage: h.lastMessage } : {}), ...(h.notify ? { notify: h.notify } : {}) };
  });
}

/**
 * The parts of a licence row's detail line, in order: the holder only when it differs from the
 * space's name (it is the row's title already), then `parts` (edition, seats, end) with a repeated
 * part kept once (an unreadable row says "Illisible" a single time).
 */
export function licenceDetail(row: { organisation: string; spaceName: string }, parts: string[]): string[] {
  const holder = row.organisation.trim();
  const same = holder.toLowerCase() === row.spaceName.trim().toLowerCase();
  const all = [...(holder && !same ? [holder] : []), ...parts];
  return all.filter((p, i) => all.indexOf(p) === i);
}
