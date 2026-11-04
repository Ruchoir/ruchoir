"use client";

import { type CSSProperties, useState } from "react";
import { Avatar, Button, Checkbox, Icon, Select, Tag } from "@/components/ds";
import type { Member } from "@/lib/data/api";
import type { Group, Role, SpaceEdition } from "@/lib/data/types";
import { getAvatar } from "@/lib/data";
import { key, useTranslation } from "@/lib/i18n";
import { formatDate, formatList } from "@/lib/i18n/format";
import type { Toast } from "../app/types";
import { MemberGroups } from "../groups/MemberGroups";
import { rolesViaGroups } from "./groupsLogic.ts";
import { ProlongDialog } from "./ProlongDialog";
import { PasserInviteDialog, PasserMembreDialog } from "./StandingDialogs";
import { saveGuestExpiry } from "./guestActions.ts";
import { browserZone, daysLeft, endLabel, expiryTone, gestionControls, inDaysLabel } from "./guestLogic.ts";
import { setGuestExpiry } from "@/lib/data/api";
import { currentLocale } from "@/lib/i18n/current";
import { PERMISSION_TEXT } from "./permissionText";
import { RoleChip, ROLE_LABEL } from "./roleChips";
import { grantableRoles, memberAccessFor, roleIdsToSave, type RoleChoice } from "./rolesLogic";

const s: Record<string, CSSProperties> = {
  section: { padding: "14px 16px", borderBottom: "1px solid var(--border-subtle)" },
  label: { fontFamily: "var(--label-font)", fontSize: "var(--text-2xs)", fontWeight: 500, color: "var(--text-muted)", marginBottom: 8 },
  note: { display: "flex", gap: 6, alignItems: "flex-start", fontSize: "var(--text-2xs)", color: "var(--text-muted)", marginTop: 8, lineHeight: "var(--leading-snug)" },
  chips: { display: "flex", flexWrap: "wrap", gap: 6 },
  row: { display: "flex", alignItems: "flex-start", gap: 8, padding: "8px 0", borderTop: "1px solid var(--border-subtle)" },
};

/**
 * The roles someone holds, strongest first, as the space's role list orders them: those given to
 * them and those their groups give. `via` is set only for a role received through a group alone.
 */
function heldRoles(member: Pick<Member, "roleIds" | "userId">, roles: Role[], groups: Group[] = []): { role: Role; via: string[] }[] {
  const direct = new Set(member.roleIds ?? []);
  const viaMap = rolesViaGroups(member, groups);
  return roles
    .filter((r) => direct.has(r.id) || viaMap.has(r.id))
    .map((role) => ({ role, via: direct.has(role.id) ? [] : (viaMap.get(role.id) ?? []) }));
}

/**
 * The "Rôles dans <espace>" section of a profile: the pastilles, and for someone the viewer could
 * manage were they lower, why nothing can be changed.
 */
export function MemberRolesSummary({
  member,
  roles,
  groups,
  spaceName,
  isSelf,
  viewerManages,
}: {
  member: Member;
  roles: Role[];
  /** The space's groups: the roles they give are marked as received through a group. */
  groups?: Group[];
  spaceName: string;
  isSelf: boolean;
  /** Whether the viewer manages people at all: only then is "above you" worth saying. */
  viewerManages: boolean;
}) {
  const { t } = useTranslation();
  const held = heldRoles(member, roles, groups);
  return (
    <div style={s.section}>
      <div style={s.label}>{t("roles.inSpace", { space: spaceName })}</div>
      <div style={s.chips}>
        {member.role === "owner" ? <Tag tone="accent" icon="star">{t("role.owner")}</Tag> : null}
        {held.map(({ role, via }) => (
          <RoleChip key={role.id} role={role} via={via} />
        ))}
        {member.role === "guest" ? <Tag tone="warning">{t("guests.guestTag")}</Tag> : null}
        {member.role !== "owner" && member.role !== "guest" && held.length === 0 ? (
          <span style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>{t("roles.membersOnly")}</span>
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
  /** The space's groups: the roles they give are shown as such, and the person's groups are managed. */
  groups?: Group[];
  spaceId?: string;
  /** A group's members changed: read the space's people and groups again. */
  onGroupsChanged?: () => Promise<void>;
  onNotify?: (toast: Toast) => void;
  /** The space's licence, to say how many seats are used once someone stops holding one. */
  seats?: { seats: number; used: number };
  /** The space's people, to tag the groups made of guests only. */
  people?: { userId: string; role: string }[];
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
export function MemberManagement({ member, me, myRole, myRights, edition, roles, identity = false, groups, spaceId, onGroupsChanged, onNotify, seats, people, onSaveRoles, onChangeRole, onRemove }: MemberManagementProps) {
  const { t } = useTranslation();
  const via = rolesViaGroups(member, groups ?? []);
  const access = memberAccessFor({ member, me: me?.userId ?? "", edition, roles, rights: myRights, viaGroups: via });
  const managesPeople = myRights.includes("members.manage");
  const legacy = grantableRoles(myRole, member.role);
  const since = member.joinedAt ? formatDate(member.joinedAt) : "";
  const [prolonging, setProlonging] = useState(false);
  const [standing, setStanding] = useState<"guest" | "member" | null>(null);
  const controls = gestionControls(member, myRights);
  const canDate = controls.endControl && !!spaceId && !!onGroupsChanged && !!onNotify;
  const guestDays = member.expiresAt ? daysLeft(member.expiresAt, new Date()) : null;
  const removeDate = async () => {
    if (!spaceId || !onGroupsChanged) return;
    try {
      await saveGuestExpiry({ setGuestExpiry }, { spaceId, userId: member.userId, choice: "none", now: new Date(), zone: browserZone() }, onGroupsChanged);
      onNotify?.({ tone: "success", title: t("guests.updated"), description: member.name });
    } catch {
      onNotify?.({ tone: "danger", title: t("guests.updateFailed") });
    }
  };
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
            {heldRoles(member, roles, groups).map(({ role, via: from }) => (
              <RoleChip key={role.id} role={role} via={from} />
            ))}
            {heldRoles(member, roles, groups).length === 0 ? (
              <span style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>{t("roles.membersOnly")}</span>
            ) : null}
          </div>
        </div>
      ) : null}
      {access.mode === "frozen" ? (
        <div style={s.section}>
          <div style={s.label}>{t("roles.title")}</div>
          <div style={s.chips}>
            {heldRoles(member, roles, groups).map(({ role, via: from }) => (
              <RoleChip key={role.id} role={role} via={from} />
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

      {member.role === "guest" && canDate ? (
        <div style={s.section}>
          <div style={s.label}>{t("guests.accessSection")}</div>
          <div style={{ display: "flex", gap: 10, padding: "10px 12px", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-card)" }}>
            <Icon name="calendar-clock" size={18} style={{ flex: "none", marginTop: 2 }} />
            <span style={{ fontSize: "var(--text-xs)", color: "var(--text-body)", lineHeight: "var(--leading-snug)" }}>
              {member.expiresAt && guestDays !== null ? (
                <>
                  <b style={{ display: "block", fontSize: "var(--text-sm)", color: "var(--text-strong)" }}>{t("files.linkUntil", { date: endLabel(member.expiresAt, currentLocale(), browserZone()) })}</b>
                  {t("guests.remaining", { when: inDaysLabel(guestDays, currentLocale()), name: member.name.split(" ")[0] })}
                  {expiryTone(guestDays) === "soon" ? <Icon name="alert-triangle" size={12} style={{ marginLeft: 4, color: "var(--status-warning-fg)" }} /> : null}
                </>
              ) : (
                t("guests.noEndInfo")
              )}
            </span>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <Button size="sm" variant="secondary" iconLeft="calendar-clock" onClick={() => setProlonging(true)}>
              {member.expiresAt ? t("guests.changeDate") : t("guests.setDate")}
            </Button>
            {member.expiresAt ? (
              <Button size="sm" variant="ghost" onClick={() => void removeDate()}>
                {t("guests.removeDate")}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {groups && spaceId && !member.bot ? (
        <MemberGroups member={member} groups={groups} roles={roles} spaceId={spaceId} viewerId={me?.userId ?? ""} viewerIsOwner={myRole === "owner"} onChanged={onGroupsChanged} onNotify={onNotify} people={people} />
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
          {/* The roles are the checklist's; the standing (guest or member) is the legacy column's, changed
              through a confirmation that says what it takes away and what it gives. */}
        </div>
        {(controls.toMember || controls.toGuest) && access.mode !== "fixed" && spaceId && onGroupsChanged ? (
          <>
            <p style={{ ...s.note, marginTop: 0, marginBottom: 8 }}>
              <Icon name="info" size={13} style={{ flex: "none", marginTop: 1 }} />
              <span>{controls.toMember ? t("guests.memberStatusNote") : t("guests.guestStatusNote")}</span>
            </p>
            <Button size="sm" variant="secondary" iconLeft="repeat" onClick={() => setStanding(controls.toMember ? "member" : "guest")}>
              {controls.toMember ? t("guests.passerMembreAction") : t("guests.passerInviteAction")}
            </Button>
          </>
        ) : null}
        {access.mode !== "fixed" && myRole === "owner" ? (
          <div style={{ marginTop: 8 }}>
            <Button size="sm" variant="link" iconLeft="star" onClick={() => onChangeRole("owner")}>
              {t("roles.handOver")}
            </Button>
          </div>
        ) : null}
      </div>

      {standing === "guest" && spaceId && onGroupsChanged ? (
        <PasserInviteDialog member={member} roles={roles} licence={seats} spaceId={spaceId} onClose={() => setStanding(null)} onChanged={onGroupsChanged} />
      ) : null}
      {standing === "member" && spaceId && onGroupsChanged ? (
        <PasserMembreDialog member={member} spaceId={spaceId} onClose={() => setStanding(null)} onChanged={onGroupsChanged} />
      ) : null}
      {prolonging && spaceId && onGroupsChanged && onNotify ? (
        <ProlongDialog
          guest={{ userId: member.userId, name: member.name, title: member.title, expiresAt: member.expiresAt }}
          spaceId={spaceId}
          onClose={() => setProlonging(false)}
          onSaved={onGroupsChanged}
          onNotify={onNotify}
        />
      ) : null}
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
  choices: RoleChoice<Role>[];
  onSave: (roleIds: string[]) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  // The draft is the person's direct roles only: what a group gives is shown ticked, never edited here.
  const initial = choices.filter((c) => c.direct).map((c) => c.role.id);
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
    const ok = await onSave(roleIdsToSave(roles, choices, draft));
    setBusy(false);
    if (!ok) setDraft(new Set(initial));
  };

  return (
    <div>
      <p style={{ fontSize: "var(--text-2xs)", color: "var(--text-muted)", margin: "0 0 6px", lineHeight: "var(--leading-snug)" }}>
        {t("roles.additive", { name: member.name })}
      </p>
      {choices.map(({ role, disabled, direct, via }) => {
        const groupOnly = !direct && via.length > 0;
        const on = draft.has(role.id) || groupOnly;
        const was = initial.includes(role.id);
        const names = formatList(via);
        const why = groupOnly
          ? t("groups.viaReason", { groups: names, count: via.length, name: member.name.split(" ")[0] })
          : disabled
            ? role.id === myTop
              ? t("roles.yourTopRole")
              : t("roles.aboveYou")
            : via.length > 0
              ? t("groups.alsoDirect", { groups: names, count: via.length })
              : adds(role);
        return (
          <div key={role.id} style={{ ...s.row, opacity: disabled ? 0.7 : 1 }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <Checkbox
                checked={on}
                disabled={disabled || busy}
                onChange={(e) => toggle(role.id, e.target.checked)}
                label={<RoleChip role={role} via={groupOnly ? via : []} />}
                description={why || undefined}
              />
            </span>
            {groupOnly ? (
              <Icon name="users" size={13} aria-hidden style={{ color: "var(--text-muted)", marginTop: 4 }} />
            ) : disabled ? (
              <Icon name="lock" size={13} style={{ color: "var(--text-muted)", marginTop: 4 }} />
            ) : null}
            {!disabled && draft.has(role.id) !== was ? <Tag tone="accent">{draft.has(role.id) ? t("roles.added") : t("roles.removed")}</Tag> : null}
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
