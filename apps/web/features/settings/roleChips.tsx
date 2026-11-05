"use client";

import { Icon, Tag } from "@/components/ds";
import type { Refusal, Role } from "@/lib/data/types";
import { key, type TranslationKey, useTranslation } from "@/lib/i18n";
import { formatList } from "@/lib/i18n/format";
import { selfRoleKey } from "./groupsLogic.ts";

type T = ReturnType<typeof useTranslation>["t"];

/** The legacy roles, as dictionary keys. */
export const ROLE_LABEL: Record<string, TranslationKey> = {
  owner: key("role.owner"),
  admin: key("role.admin"),
  member: key("role.member"),
  guest: key("role.guest"),
};

/** A role's colour: one of the design system's pastels, a neutral line for the base roles. */
export function roleColour(role: Pick<Role, "colour" | "systemKey">): string {
  if (role.systemKey === "administrator") return "var(--peach)";
  return role.colour ? `var(--${role.colour})` : "var(--line-strong)";
}

/** A role's name as the reader says it: the system roles in their language, the others as named. */
export function roleLabel(role: Pick<Role, "name" | "systemKey">, t: T): string {
  if (role.systemKey === "administrator") return t("role.admin");
  if (role.systemKey === "members") return t("roles.everyone");
  if (role.systemKey === "guests") return t("roles.guests");
  return role.name;
}

export function RoleDot({ role, size = 8 }: { role: Pick<Role, "colour" | "systemKey">; size?: number }) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, flex: "none", borderRadius: "var(--radius-full)", background: roleColour(role), display: "inline-block" }}
    />
  );
}

/**
 * A role as a pastille: its colour, its name. `via` names the groups it is received through (and
 * only those: a role held directly is a plain chip): a small group icon, and the names on hover.
 */
export function RoleChip({ role, via }: { role: Role; via?: string[] }) {
  const { t } = useTranslation();
  const groups = via ?? [];
  const reason = groups.length > 0 ? t("groups.viaTooltip", { groups: formatList(groups), count: groups.length }) : undefined;
  return (
    <Tag>
      <span title={reason} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <RoleDot role={role} />
        {roleLabel(role, t)}
        {reason ? <Icon name="users" size={12} aria-hidden style={{ color: "var(--text-muted)" }} /> : null}
      </span>
    </Tag>
  );
}

/**
 * What a named refusal of the API means, in plain words; `fallback` for any other failure.
 * `context` says what was being done where the same refusal reads differently: changing the roles
 * of a group (default) or changing who is in it.
 */
export function refusalMessage(refusal: Refusal | undefined, t: T, fallback: string, context: "roles" | "members" = "roles"): string {
  switch (refusal?.code) {
    case "seats_full":
      return t("roles.refusal.seatsFull", { count: refusal.seats });
    case "rate_limited":
      return t("roles.refusal.rateLimited");
    case "licence_required":
      return t("roles.refusal.licenceRequired");
    case "licence_frozen":
      return t("roles.refusal.licenceFrozen");
    case "licence_invalid":
      return t("licence.refusal.invalid");
    case "licence_other_space":
      return refusal.organisation
        ? t("licence.refusal.otherSpaceNamed", { organisation: refusal.organisation })
        : t("licence.refusal.otherSpace");
    case "licence_expired":
      return t("licence.refusal.expired");
    case "licence_service_unreachable":
      return t("licence.refusalService.serviceUnreachable");
    case "licence_check_too_soon":
      return t("licence.refusalService.checkTooSoon");
    case "role_above_you":
      return t("roles.refusal.roleAboveYou");
    case "person_above_you":
      return t("roles.refusal.personAboveYou");
    case "permission_not_held":
      return t("roles.refusal.permissionNotHeld");
    case "role_name_reserved":
      return t("roles.refusal.nameReserved");
    case "role_name_taken":
      return t("roles.refusal.nameTaken");
    case "role_has_rules":
      return t("roles.refusal.hasRules");
    case "beyond_guest_ceiling":
      return t("roles.refusal.beyondGuestCeiling");
    case "make_them_a_member_first":
      return t("roles.refusal.memberFirst");
    case "bad_expiry":
      return t("guests.refusalBadExpiry");
    case "guest_only":
      return t("guests.refusalGuestOnly");
    case "access_ended":
      return t("guests.refusalAccessEnded");
    case "not_ended":
      return t("guests.refusalNotEnded");
    case "access_ended_for_good":
      return t("guests.endedForGood");
    case "no_self_role":
      return t(selfRoleKey(context));
    case "manager_protected":
      return t("groups.refusal.managerProtected");
    case "group_from_directory":
      return t("groups.refusal.fromDirectory");
    case "group_name_taken":
      return t("groups.refusal.nameTaken");
    case "group_name_reserved":
      return t("groups.refusal.nameReserved");
    case "group_name_invalid":
      return t("groups.refusal.nameInvalid");
    case "manager_must_be_member":
      return t("groups.refusal.managerMustBeMember");
    case "base_role_not_allowed":
      return t("groups.refusal.baseRole");
    case "not_in_space":
      return t("groups.refusal.notInSpace");
    case "too_many_people":
      return t("groups.refusal.tooManyPeople");
    case "cannot_grant":
      return t("access.refusal.cannotGrant");
    case "target_above_you":
      return t("access.refusal.targetAboveYou");
    case "reservation_admins_only":
      return t("access.refusal.reservationAdminsOnly");
    case "guest_ceiling":
      return t("access.refusal.guestCeiling");
    case "audience_files_only":
      return t("access.refusal.audienceFilesOnly");
    case "base_role_levels_only":
      return t("access.refusal.baseRoleLevelsOnly");
    case "permission_in_both":
      return t("access.refusal.permissionInBoth");
    case "base_role_not_previewable":
      return t("preview.refusal.baseRole");
    case "preview_read_only":
      return t("preview.readOnlyTitle");
    case "preview_unavailable":
      return t("preview.refusal.unavailable");
    default:
      return fallback;
  }
}
