/** The instance administrator's list of licences: one line per space, soonest end first. */

import type { AdminLicence, Workspace } from "../types.ts";
import { daysLeftBanner } from "./audit.ts";
import { daysLeft } from "./guests.ts";

export type { AdminLicence };

export type LicenceRow = AdminLicence & { daysLeft: number; frozen: boolean; soon: boolean };

/** Days under which the owners are warned by mail (30, 7, 1). */
const LICENCE_SOON_DAYS = 30;

/** The rows sorted by soonest expiry (an expired one first), with the days left counted in `zone`. */
export function licenceRows(list: AdminLicence[], now: Date, zone: string): LicenceRow[] {
  return list
    .map((l) => {
      const days = daysLeft(l.validUntil, now, zone);
      const frozen = l.edition === "frozen";
      return { ...l, daysLeft: days, frozen, soon: !frozen && l.edition === "enterprise" && days <= LICENCE_SOON_DAYS };
    })
    .sort((a, b) => Date.parse(a.validUntil) - Date.parse(b.validUntil));
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
  licence?: { expiresInDays: number };
}): { kind: "ends"; tone: "warning" | "danger"; days: number } | { kind: "frozen" } | null {
  if (space.role !== "owner") return null;
  if (space.edition === "frozen") return { kind: "frozen" };
  const ends = daysLeftBanner(space.licence, space.edition);
  return ends ? { kind: "ends", ...ends } : null;
}
