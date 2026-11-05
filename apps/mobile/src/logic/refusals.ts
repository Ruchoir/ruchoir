/**
 * What the API's named refusals say on the members screens, as dictionary keys and their variables
 * (the web's `refusalMessage`, for the codes a member's roles, standing and end date can meet). `null`
 * is any other failure: the screen then says its own generic sentence.
 */
import type { refusalOf } from "@ruchoir/client";

import { key } from "../i18n";

export type Said = { key: string; vars?: Record<string, number | string> };


const BY_CODE: Record<string, string> = {
  rate_limited: key("roles.refusal.rateLimited"),
  licence_required: key("roles.refusal.licenceRequired"),
  licence_frozen: key("roles.refusal.licenceFrozen"),
  role_above_you: key("roles.refusal.roleAboveYou"),
  person_above_you: key("roles.refusal.personAboveYou"),
  permission_not_held: key("roles.refusal.permissionNotHeld"),
  beyond_guest_ceiling: key("roles.refusal.beyondGuestCeiling"),
  make_them_a_member_first: key("roles.refusal.memberFirst"),
  role_name_taken: key("roles.refusal.nameTaken"),
  role_name_reserved: key("roles.refusal.nameReserved"),
  bad_expiry: key("guests.refusalBadExpiry"),
  guest_only: key("guests.refusalGuestOnly"),
  access_ended: key("guests.refusalAccessEnded"),
  not_ended: key("guests.refusalNotEnded"),
  access_ended_for_good: key("guests.endedForGood"),
  no_self_role: key("groups.noSelfRole"),
  licence_invalid: key("licence.refusal.invalid"),
  licence_expired: key("licence.refusal.expired"),
  manager_protected: key("groups.refusal.managerProtected"),
  group_from_directory: key("groups.refusal.fromDirectory"),
  group_name_taken: key("groups.refusal.nameTaken"),
  group_name_reserved: key("groups.refusal.nameReserved"),
  group_name_invalid: key("groups.refusal.nameInvalid"),
  manager_must_be_member: key("groups.refusal.managerMustBeMember"),
  base_role_not_allowed: key("groups.refusal.baseRole"),
  not_in_space: key("groups.refusal.notInSpace"),
  too_many_people: key("groups.refusal.tooManyPeople"),
  group_has_rules: key("groups.refusal.hasRules"),
  cannot_grant: key("access.refusal.cannotGrant"),
  target_above_you: key("access.refusal.targetAboveYou"),
  reservation_admins_only: key("access.refusal.reservationAdminsOnly"),
  guest_ceiling: key("access.refusal.guestCeiling"),
  audience_files_only: key("access.refusal.audienceFilesOnly"),
  base_role_levels_only: key("access.refusal.baseRoleLevelsOnly"),
  permission_in_both: key("access.refusal.permissionInBoth"),
};

export function refusalSaid(refusal: ReturnType<typeof refusalOf>): Said | null {
  if (!refusal) return null;
  if (refusal.code === "seats_full") return { key: key("roles.refusal.seatsFull"), vars: { count: refusal.seats } };
  if (refusal.code === "licence_other_space") {
    return refusal.organisation
      ? { key: key("licence.refusal.otherSpaceNamed"), vars: { organisation: refusal.organisation } }
      : { key: key("licence.refusal.otherSpace") };
  }
  const said = BY_CODE[refusal.code];
  return said ? { key: said } : null;
}
