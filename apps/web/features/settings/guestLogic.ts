import {
  daysLeft as sharedDaysLeft,
  guestRow as sharedGuestRow,
  type EndChoice,
  SOON_DAYS,
  MAX_YEARS,
  presetToInstant,
  dateRefusal,
  dateBounds,
  expiryTone,
  showsEndDate,
  endLabel,
  inDaysLabel,
  keepLabel,
  choiceRefusal,
  splitPeople,
  canSeeEnded,
  type Line,
  standingLoss,
  standingGain,
  seatsAfterInvite,
  gestionControls,
  guestBanner,
  isGuestsOnly,
  groupTagFor,
  guestMenu,
  guestRefusalKey,
} from "@ruchoir/client/permissionsLogic";

/** The guest screens' decisions, shared with the apps: see `@ruchoir/client/permissionsLogic`. */
export {
  type EndChoice,
  SOON_DAYS,
  MAX_YEARS,
  presetToInstant,
  dateRefusal,
  dateBounds,
  expiryTone,
  showsEndDate,
  endLabel,
  inDaysLabel,
  keepLabel,
  choiceRefusal,
  splitPeople,
  canSeeEnded,
  type Line,
  standingLoss,
  standingGain,
  seatsAfterInvite,
  gestionControls,
  guestBanner,
  isGuestsOnly,
  groupTagFor,
  guestMenu,
  guestRefusalKey,
};

/** The zone this browser reads dates in. */
export function browserZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** `daysLeft` in this browser's zone unless one is given (the apps pass their own). */
export const daysLeft = (iso: string, now: Date, zone: string = browserZone()): number => sharedDaysLeft(iso, now, zone);

/** `guestRow` in this browser's zone unless one is given. */
export const guestRow = (guest: { expiresAt?: string }, now: Date, zone: string = browserZone()) => sharedGuestRow(guest, now, zone);
