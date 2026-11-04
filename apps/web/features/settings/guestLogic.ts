import {
  pickZone,
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

/** The profile zone of the signed-in person, set by the app root (`setProfileZone`). */
let profileZone: string | undefined;
export function setProfileZone(zone: string | undefined): void {
  profileZone = zone;
}

/** The one zone guest and licence dates are read in: the profile's when set (as the rest of the app), else this browser's. */
export function displayZone(): string {
  return pickZone(profileZone, Intl.DateTimeFormat().resolvedOptions().timeZone);
}

/** `daysLeft` in this browser's zone unless one is given (the apps pass their own). */
export const daysLeft = (iso: string, now: Date, zone: string = displayZone()): number => sharedDaysLeft(iso, now, zone);

/** `guestRow` in this browser's zone unless one is given. */
export const guestRow = (guest: { expiresAt?: string }, now: Date, zone: string = displayZone()) => sharedGuestRow(guest, now, zone);
