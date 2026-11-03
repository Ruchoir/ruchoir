"use client";

import { type CSSProperties, useState } from "react";
import { Avatar, Button, Checkbox, Icon, Select, Tag } from "@/components/ds";
import type { Member } from "@/lib/data/api";
import type { Refusal, Role, SpaceEdition } from "@/lib/data/types";
import { getAvatar } from "@/lib/data";
import { key, type TranslationKey, useTranslation } from "@/lib/i18n";
import { formatDate } from "@/lib/i18n/format";
import { PERMISSION_TEXT } from "./permissionText";
import { grantableRoles, memberAccessFor } from "./rolesLogic";

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

/** A role as a pastille: its colour, its name. */
export function RoleChip({ role }: { role: Role }) {
  const { t } = useTranslation();
  return (
    <Tag>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <RoleDot role={role} />
        {roleLabel(role, t)}
      </span>
    </Tag>
  );
}

/** What a named refusal of the API means, in plain words; `fallback` for any other failure. */
export function refusalMessage(refusal: Refusal | undefined, t: T, fallback: string): string {
  switch (refusal?.code) {
    case "seats_full":
      return t("roles.refusal.seatsFull", { count: refusal.seats });
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
    case "no_self_role":
      return t("groups.noSelfRole");
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
    default:
      return fallback;
  }
}

const s: Record<string, CSSProperties> = {
  section: { padding: "14px 16px", borderBottom: "1px solid var(--border-subtle)" },
  label: { fontFamily: "var(--label-font)", fontSize: "var(--text-2xs)", fontWeight: 500, color: "var(--text-muted)", marginBottom: 8 },
  note: { display: "flex", gap: 6, alignItems: "flex-start", fontSize: "var(--text-2xs)", color: "var(--text-muted)", marginTop: 8, lineHeight: "var(--leading-snug)" },
  chips: { display: "flex", flexWrap: "wrap", gap: 6 },
  row: { display: "flex", alignItems: "flex-start", gap: 8, padding: "8px 0", borderTop: "1px solid var(--border-subtle)" },
};

/** The roles someone holds, strongest first, as the space's role list orders them. */
function heldRoles(member: Pick<Member, "roleIds">, roles: Role[]): Role[] {
  const held = new Set(member.roleIds ?? []);
  return roles.filter((r) => held.has(r.id));
}

/**
 * The "Rôles dans <espace>" section of a profile: the pastilles, and for someone the viewer could
 * manage were they lower, why nothing can be changed.
 */
export function MemberRolesSummary({
  member,
  roles,
  spaceName,
  isSelf,
  viewerManages,
}: {
  member: Member;
  roles: Role[];
  spaceName: string;
  isSelf: boolean;
  /** Whether the viewer manages people at all: only then is "above you" worth saying. */
  viewerManages: boolean;
}) {
  const { t } = useTranslation();
  const held = heldRoles(member, roles);
  return (
    <div style={s.section}>
      <div style={s.label}>{t("roles.inSpace", { space: spaceName })}</div>
      <div style={s.chips}>
        {member.role === "owner" ? <Tag tone="accent" icon="star">{t("role.owner")}</Tag> : null}
        {held.map((role) => (
          <RoleChip key={role.id} role={role} />
        ))}
        {member.role !== "owner" && held.length === 0 ? (
          <span style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
            {member.role === "guest" ? t("roles.guestCeiling") : t("roles.membersOnly")}
          </span>
        ) : null}
      </div>
      {!isSelf && viewerManages && member.manageable === false ? (
        <div style={s.note}>
          <Icon name="lock" size={13} />
          <span>{t("roles.personAboveNote", { name: member.name })}</span>
        </div>
      ) : null}
    </div>
  );
}

export type MemberManagementProps = {
  member: Member;
  /** The viewer's own membership: their strongest role names the "your highest role" rows. */
  me?: Member;
  myRole: string;
  /** What the viewer holds in the space: roles are ticked with `roles.manage`, people are removed and
   * their standing changed with `members.manage`. */
  myRights: string[];
  edition: SpaceEdition;
  roles: Role[];
  /** Draw the person's identity line first: the profile's tab has no title naming them. */
  identity?: boolean;
  /** Set their roles (strongest first); resolves to whether it was saved. */
  onSaveRoles: (roleIds: string[]) => Promise<boolean>;
  /** Change their legacy role or standing, handing the space over included (confirmed upstream). */
  onChangeRole: (role: string) => void;
  onRemove: () => void;
};

/**
 * One person's standing, roles and removal, as someone allowed to manage them sees it. The Members
 * tab's dialog and the profile's "Gestion" tab draw this same component, so both offer and refuse
 * the same things; the API is the judge either way.
 */
export function MemberManagement({ member, me, myRole, myRights, edition, roles, identity = false, onSaveRoles, onChangeRole, onRemove }: MemberManagementProps) {
  const { t } = useTranslation();
  const access = memberAccessFor({ member, me: me?.userId ?? "", edition, roles, rights: myRights });
  const managesPeople = myRights.includes("members.manage");
  const legacy = grantableRoles(myRole, member.role);
  const since = member.joinedAt ? formatDate(member.joinedAt) : "";
  return (
    <div>
      {identity ? (
        <div style={{ ...s.section, display: "flex", alignItems: "center", gap: 10 }}>
          <Avatar name={member.name} src={member.avatarUrl ?? getAvatar(member.name)} size={40} />
          <span style={{ minWidth: 0 }}>
            <div style={{ fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--text-strong)" }}>{member.name}</div>
            <div style={{ fontSize: "var(--text-2xs)", color: "var(--text-muted)" }}>
              {[member.title, t(ROLE_LABEL[member.role] ?? key("role.member"))].filter(Boolean).join(" · ")}
            </div>
          </span>
        </div>
      ) : null}

      {access.mode === "roles" ? (
        <div style={s.section}>
          <div style={s.label}>{t("roles.title")}</div>
          <RoleChecklist member={member} me={me} roles={roles} choices={access.choices} onSave={onSaveRoles} />
        </div>
      ) : null}
      {access.mode === "held" ? (
        <div style={s.section}>
          <div style={s.label}>{t("roles.title")}</div>
          <div style={s.chips}>
            {heldRoles(member, roles).map((role) => (
              <RoleChip key={role.id} role={role} />
            ))}
            {heldRoles(member, roles).length === 0 ? (
              <span style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>{t("roles.membersOnly")}</span>
            ) : null}
          </div>
        </div>
      ) : null}
      {access.mode === "frozen" ? (
        <div style={s.section}>
          <div style={s.label}>{t("roles.title")}</div>
          <div style={s.chips}>
            {heldRoles(member, roles).map((role) => (
              <RoleChip key={role.id} role={role} />
            ))}
          </div>
          <div style={s.note}>
            <Icon name="clock" size={13} />
            <span>{t("roles.frozenNote")}</span>
          </div>
        </div>
      ) : null}
      {access.mode === "fixed" ? (
        <div style={s.section}>
          <div style={s.label}>{t("roles.legacyTitle")}</div>
          {legacy.length > 0 && !member.bot ? (
            <div style={{ maxWidth: 220 }}>
              <Select
                size="sm"
                aria-label={t("channel.roleOf", { name: member.name })}
                value={member.role}
                onChange={(e) => onChangeRole(e.target.value)}
                options={legacy.map((value) => ({ value, label: t(ROLE_LABEL[value] ?? key("role.member")) }))}
              />
            </div>
          ) : (
            <span style={{ fontSize: "var(--text-xs)", color: "var(--text-body)" }}>{t(ROLE_LABEL[member.role] ?? key("role.member"))}</span>
          )}
        </div>
      ) : null}

      <div style={s.section}>
        <div style={s.label}>{t("roles.standing")}</div>
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10, fontSize: "var(--text-xs)", color: "var(--text-body)" }}>
          <span style={{ flex: 1, minWidth: 0 }}>
            {since
              ? member.role === "guest"
                ? t("roles.guestSince", { date: since })
                : t("roles.memberSince", { date: since })
              : t(ROLE_LABEL[member.role] ?? key("role.member"))}
          </span>
          {/* In a licensed space the roles are the checklist's; the standing (guest or member) stays
              the legacy column's, which the API changes under the same rank rule. */}
          {access.mode !== "fixed" && managesPeople && (member.role === "guest" || member.role === "member") ? (
            <div style={{ width: 150 }}>
              <Select
                size="sm"
                aria-label={t("roles.standingOf", { name: member.name })}
                value={member.role}
                onChange={(e) => onChangeRole(e.target.value)}
                options={[
                  { value: "member", label: t("role.member") },
                  { value: "guest", label: t("role.guest") },
                ]}
              />
            </div>
          ) : null}
        </div>
        {access.mode !== "fixed" && myRole === "owner" ? (
          <div style={{ marginTop: 8 }}>
            <Button size="sm" variant="link" iconLeft="star" onClick={() => onChangeRole("owner")}>
              {t("roles.handOver")}
            </Button>
          </div>
        ) : null}
      </div>

      {managesPeople ? (
        <div style={{ ...s.section, borderBottom: 0 }}>
          <Button size="sm" variant="ghost" iconLeft="user-minus" onClick={onRemove} style={{ color: "var(--status-danger-fg)" }}>
            {t("space.remove")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** The roles to tick, with the ones the viewer may not give disabled and saying why. */
function RoleChecklist({
  member,
  me,
  roles,
  choices,
  onSave,
}: {
  member: Member;
  me?: Member;
  roles: Role[];
  choices: { role: Role; checked: boolean; disabled: boolean }[];
  onSave: (roleIds: string[]) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const initial = choices.filter((c) => c.checked).map((c) => c.role.id);
  const [draft, setDraft] = useState<Set<string>>(() => new Set(initial));
  const [busy, setBusy] = useState(false);
  const dirty = initial.length !== draft.size || initial.some((id) => !draft.has(id));
  const base = roles.find((r) => r.systemKey === "members")?.permissions ?? [];
  const myTop = me?.roleIds?.[0];

  /** What a role adds to @membres, in a few words. */
  const adds = (role: Role) => {
    const extra = role.permissions.filter((p) => !base.includes(p) && PERMISSION_TEXT[p]);
    if (extra.length === 0) return "";
    const names = extra.slice(0, 3).map((p) => t(PERMISSION_TEXT[p].title));
    return extra.length > 3 ? t("roles.addsMore", { list: names.join(", "), count: extra.length - 3 }) : names.join(", ");
  };

  const toggle = (id: string, on: boolean) =>
    setDraft((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const save = async () => {
    setBusy(true);
    // Strongest first, as the space orders its roles: the order the route expects.
    const ok = await onSave(roles.filter((r) => draft.has(r.id)).map((r) => r.id));
    setBusy(false);
    if (!ok) setDraft(new Set(initial));
  };

  return (
    <div>
      <p style={{ fontSize: "var(--text-2xs)", color: "var(--text-muted)", margin: "0 0 6px", lineHeight: "var(--leading-snug)" }}>
        {t("roles.additive", { name: member.name })}
      </p>
      {choices.map(({ role, disabled }) => {
        const on = draft.has(role.id);
        const was = initial.includes(role.id);
        const why = disabled ? (role.id === myTop ? t("roles.yourTopRole") : t("roles.aboveYou")) : adds(role);
        return (
          <div key={role.id} style={{ ...s.row, opacity: disabled ? 0.7 : 1 }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <Checkbox
                checked={on}
                disabled={disabled || busy}
                onChange={(e) => toggle(role.id, e.target.checked)}
                label={<RoleChip role={role} />}
                description={why || undefined}
              />
            </span>
            {disabled ? <Icon name="lock" size={13} style={{ color: "var(--text-muted)", marginTop: 4 }} /> : null}
            {!disabled && on !== was ? <Tag tone="accent">{on ? t("roles.added") : t("roles.removed")}</Tag> : null}
          </div>
        );
      })}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
        <Button size="sm" variant="ghost" disabled={!dirty || busy} onClick={() => setDraft(new Set(initial))}>
          {t("common.cancel")}
        </Button>
        <Button size="sm" variant="primary" disabled={!dirty || busy} onClick={() => void save()}>
          {busy ? t("common.sending") : t("common.save")}
        </Button>
      </div>
    </div>
  );
}
