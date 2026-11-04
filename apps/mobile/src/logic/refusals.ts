/**
 * What the API's named refusals say on the members screens, as dictionary keys and their variables
 * (the web's `refusalMessage`, for the codes a member's roles, standing and end date can meet). `null`
 * is any other failure: the screen then says its own generic sentence.
 */
import type { refusalOf } from "@ruchoir/client";

import { key } from "../i18n";

export type Said = { key: string; vars?: Record<string, number | string> };


const BY_CODE: Record<string, string> = {
  licence_required: key("roles.refusal.licenceRequired"),
  licence_frozen: key("roles.refusal.licenceFrozen"),
  role_above_you: key("roles.refusal.roleAboveYou"),
  person_above_you: key("roles.refusal.personAboveYou"),
  permission_not_held: key("roles.refusal.permissionNotHeld"),
  beyond_guest_ceiling: key("roles.refusal.beyondGuestCeiling"),
  make_them_a_member_first: key("roles.refusal.memberFirst"),
  bad_expiry: key("guests.refusalBadExpiry"),
  guest_only: key("guests.refusalGuestOnly"),
  access_ended: key("guests.refusalAccessEnded"),
  not_ended: key("guests.refusalNotEnded"),
  access_ended_for_good: key("guests.endedForGood"),
  no_self_role: key("groups.noSelfRole"),
};

export function refusalSaid(refusal: ReturnType<typeof refusalOf>): Said | null {
  if (!refusal) return null;
  if (refusal.code === "seats_full") return { key: key("roles.refusal.seatsFull"), vars: { count: refusal.seats } };
  const said = BY_CODE[refusal.code];
  return said ? { key: said } : null;
}
