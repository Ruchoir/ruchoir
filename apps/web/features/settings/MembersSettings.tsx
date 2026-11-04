"use client";

import { type CSSProperties, useState } from "react";
import { Avatar, Button, Card, Dialog, Icon, IconButton, Input, Select, Tag, Tooltip } from "@/components/ds";
import type { Presence } from "@/components/ds";
import type { Member } from "@/lib/data/api";
import type { Group, Role, SpaceEdition } from "@/lib/data/types";
import { getAvatar } from "@/lib/data";
import { key, useTranslation } from "@/lib/i18n";
import { MemberManagement } from "./MemberAccess";
import { RoleChip, roleLabel, ROLE_LABEL } from "./roleChips";
import type { Toast } from "../app/types";
import { holdsRole, rolesViaGroups, sortGroups } from "./groupsLogic.ts";
import { grantableRoles } from "./rolesLogic";

export type SettingsMember = Member & { presence: Presence };

const st: Record<string, CSSProperties> = {
  h: { fontSize: "clamp(28px, 3.4vw, 40px)", fontWeight: 700, letterSpacing: "var(--tracking-display)", lineHeight: 1.05, color: "var(--text-strong)", marginBottom: 10 },
  sub: { fontSize: "var(--text-md)", color: "var(--text-body)", marginBottom: 20 },
  row: { display: "flex", alignItems: "center", gap: 12, padding: "10px 14px" },
  name: { fontSize: "var(--text-xs)", fontWeight: 500, color: "var(--text-strong)" },
  title: { fontSize: "var(--text-2xs)", color: "var(--text-muted)" },
  roles: { width: 260, flex: "none", display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "flex-start" },
  act: { width: 28, flex: "none", display: "flex", justifyContent: "flex-end", color: "var(--text-muted)" },
  foot: { display: "flex", alignItems: "center", gap: 6, fontSize: "var(--text-2xs)", color: "var(--text-muted)", marginTop: 10 },
};

export type MembersSettingsProps = {
  spaceName: string;
  edition: SpaceEdition;
  members: SettingsMember[];
  /** The viewer's own membership. */
  me?: SettingsMember;
  myRole: string;
  /** What the viewer holds in the space. */
  myRights: string[];
  /** The space's roles, strongest first (empty from an instance without them). */
  roles: Role[];
  /** The space's groups (empty when it lists none to the viewer). */
  groups: Group[];
  spaceId: string;
  /** A group's members changed: read the people and groups again. */
  onGroupsChanged: () => Promise<void>;
  onNotify: (toast: Toast) => void;
  canInvite: boolean;
  summary: string;
  onInvite: () => void;
  onChangeRole: (member: { userId: string; name: string }, role: string) => void;
  onRemoveMember: (member: { userId: string; name: string }) => void;
  onSaveMemberRoles: (userId: string, roleIds: string[]) => Promise<boolean>;
  compact?: boolean;
};

/** The Members tab: who is here and, for those the viewer may manage, the way to their roles. */
export function MembersSettings(props: MembersSettingsProps) {
  const { members, edition, roles, groups, me, myRole, compact } = props;
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [groupFilter, setGroupFilter] = useState("");
  const [managing, setManaging] = useState<string | null>(null);
  const licensed = edition !== "community";
  const ranked = roles.filter((r) => r.systemKey !== "members" && r.systemKey !== "guests");
  const shown = members.filter(
    (m) => m.name.toLowerCase().includes(query.trim().toLowerCase()) && (!roleFilter || holdsRole(m, roleFilter, groups)) &&
      (!groupFilter || groups.find((g) => g.id === groupFilter)?.memberIds.includes(m.userId)),
  );
  const managed = managing ? members.find((m) => m.userId === managing) : undefined;
  const myTop = me?.roleIds?.[0] ? roles.find((r) => r.id === me.roleIds?.[0]) : undefined;

  return (
    <>
      <h2 style={st.h}>{t("conversation.members")}</h2>
      <p style={st.sub}>{props.summary}</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
        <div style={{ width: 260 }}>
          <Input size="sm" icon="search" placeholder={t("space.searchMember")} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        {licensed && ranked.length > 0 ? (
          <div style={{ width: 190 }}>
            <Select
              size="sm"
              aria-label={t("roles.filter")}
              value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value)}
              options={[{ value: "", label: t("roles.allRoles") }, ...ranked.map((r) => ({ value: r.id, label: roleLabel(r, t) }))]}
            />
          </div>
        ) : null}
        {licensed && groups.length > 0 ? (
          <div style={{ width: 190 }}>
            <Select
              size="sm"
              aria-label={t("groups.filter")}
              value={groupFilter}
              onChange={(e) => setGroupFilter(e.target.value)}
              options={[{ value: "", label: t("groups.allGroups") }, ...sortGroups(groups).map((g) => ({ value: g.id, label: g.name }))]}
            />
          </div>
        ) : null}
        <div style={{ flex: 1 }} />
        {props.canInvite ? (
          <Button size="sm" variant="primary" iconLeft="user-plus" onClick={props.onInvite}>
            {t("space.invite")}
          </Button>
        ) : null}
      </div>
      <Card>
        {licensed && !compact ? (
          <div style={{ ...st.row, padding: "8px 14px", fontFamily: "var(--label-font)", fontSize: "var(--text-2xs)", color: "var(--text-muted)", borderBottom: "1px solid var(--border-subtle)" }}>
            <span style={{ flex: 1 }}>{t("roles.colPerson")}</span>
            <span style={st.roles}>{t("roles.title")}</span>
            <span style={st.act} />
          </div>
        ) : null}
        {shown.map((m, i) =>
          licensed ? (
            <LicensedRow key={m.userId} member={m} first={i === 0} me={me} roles={roles} groups={groups} compact={compact} onManage={() => setManaging(m.userId)} />
          ) : (
            <CommunityRow key={m.userId} member={m} first={i === 0} myRole={myRole} onChangeRole={props.onChangeRole} onRemoveMember={props.onRemoveMember} />
          ),
        )}
      </Card>
      {licensed && groups.some((g) => g.roleIds.length > 0 && g.memberIds.length > 0) ? (
        <p style={st.foot}>
          <Icon name="users" size={12} />
          {t("groups.viaFootnote")}
        </p>
      ) : null}
      {licensed && myTop && myRole !== "owner" ? (
        <p style={st.foot}>
          <Icon name="lock" size={12} />
          {t("roles.actOnBelow", { role: roleLabel(myTop, t) })}
        </p>
      ) : null}
      {managed ? (
        <Dialog
          open
          title={t("roles.manageNamed", { name: managed.name })}
          onClose={() => setManaging(null)}
          closeLabel={t("common.close")}
        >
          {/* Its sections run edge to edge, as in the profile panel. */}
          <div style={{ margin: "0 calc(-1 * var(--space-5)) calc(-1 * var(--space-5))" }}>
            <MemberManagement
              member={managed}
              me={me}
              myRole={myRole}
              myRights={props.myRights}
              edition={edition}
              roles={roles}
              groups={groups}
              spaceId={props.spaceId}
              onGroupsChanged={props.onGroupsChanged}
              onNotify={props.onNotify}
              onSaveRoles={(roleIds) => props.onSaveMemberRoles(managed.userId, roleIds)}
              onChangeRole={(role) => {
                setManaging(null);
                props.onChangeRole({ userId: managed.userId, name: managed.name }, role);
              }}
              onRemove={() => {
                setManaging(null);
                props.onRemoveMember({ userId: managed.userId, name: managed.name });
              }}
            />
          </div>
        </Dialog>
      ) : null}
    </>
  );
}

function Identity({ member }: { member: SettingsMember }) {
  const { t } = useTranslation();
  const guest = member.role === "guest";
  return (
    <>
      <Avatar name={member.name} src={member.avatarUrl ?? getAvatar(member.name)} size={28} presence={member.presence} shape={guest ? "round" : "square"} />
      <span style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <span style={{ minWidth: 0 }}>
          <div style={st.name}>{member.name}</div>
          {member.title ? <div style={st.title}>{member.title}</div> : null}
        </span>
        {member.role === "owner" ? <Tag tone="accent" icon="star">{t("role.owner")}</Tag> : null}
        {member.bot ? <Tag>{t("sidebar.bot")}</Tag> : null}
        {guest ? <Tag tone="warning">{t("space.external")}</Tag> : null}
      </span>
    </>
  );
}

/** A licensed space: the person, their roles as pastilles, and the way in or the reason there is none. */
function LicensedRow({ member, first, me, roles, groups, compact, onManage }: { member: SettingsMember; first: boolean; me?: SettingsMember; roles: Role[]; groups: Group[]; compact?: boolean; onManage: () => void }) {
  const { t } = useTranslation();
  const via = rolesViaGroups(member, groups);
  // Held directly or through a group: a role held both ways is a plain chip, it is held directly.
  const held = roles.filter((r) => member.roleIds?.includes(r.id) || via.has(r.id));
  const self = member.userId === me?.userId;
  return (
    <div style={{ ...st.row, flexWrap: compact ? "wrap" : "nowrap", borderTop: first ? "none" : "1px solid var(--border-subtle)" }}>
      <Identity member={member} />
      <span style={compact ? { ...st.roles, width: "100%", order: 3, paddingLeft: 40 } : st.roles}>
        {member.role === "owner" ? (
          <span style={st.title}>{t("roles.allRights")}</span>
        ) : held.length > 0 ? (
          held.map((r) => <RoleChip key={r.id} role={r} via={member.roleIds?.includes(r.id) ? [] : via.get(r.id)} />)
        ) : (
          <span style={st.title}>{member.role === "guest" ? t("roles.guestCeiling") : t("roles.membersOnly")}</span>
        )}
      </span>
      <span style={st.act}>
        {member.bot ? null : self ? (
          <Tooltip label={t("roles.selfLocked")}>
            <span tabIndex={0} aria-label={t("roles.selfLocked")} style={{ display: "flex" }}>
              <Icon name="lock" size={13} />
            </span>
          </Tooltip>
        ) : member.manageable ? (
          <IconButton icon="more-horizontal" size="sm" label={t("roles.manageNamed", { name: member.name })} onClick={onManage} />
        ) : (
          <Tooltip label={t("roles.aboveYou")}>
            <span tabIndex={0} aria-label={t("roles.aboveYou")} style={{ display: "flex" }}>
              <Icon name="lock" size={13} />
            </span>
          </Tooltip>
        )}
      </span>
    </div>
  );
}

/**
 * A community space, as before: the role select for everyone the viewer outranks, a plain reading
 * for the rest, their own row included, and the removal next to it.
 */
function CommunityRow({
  member,
  first,
  myRole,
  onChangeRole,
  onRemoveMember,
}: {
  member: SettingsMember;
  first: boolean;
  myRole: string;
  onChangeRole: (member: { userId: string; name: string }, role: string) => void;
  onRemoveMember: (member: { userId: string; name: string }) => void;
}) {
  const { t } = useTranslation();
  const grantable = grantableRoles(myRole, member.role);
  return (
    <div style={{ ...st.row, borderTop: first ? "none" : "1px solid var(--border-subtle)" }}>
      <Identity member={member} />
      {/* One slot the height of the control it may hold, wide enough for "Administrateur". */}
      <div style={{ width: 164, height: 28, flex: "none", display: "flex", alignItems: "center", justifyContent: "flex-end" }}>
        {member.bot ? null : grantable.length > 0 ? (
          <Select
            size="sm"
            aria-label={t("channel.roleOf", { name: member.name })}
            value={member.role}
            onChange={(e) => onChangeRole({ userId: member.userId, name: member.name }, e.target.value)}
            options={grantable.map((value) => ({ value, label: t(ROLE_LABEL[value] ?? key("role.member")) }))}
          />
        ) : (
          <span style={st.title}>{t(ROLE_LABEL[member.role] ?? key("role.member"))}</span>
        )}
      </div>
      <div style={st.act}>
        {!member.bot && grantable.length > 0 ? (
          <IconButton
            icon="user-minus"
            size="sm"
            label={t("space.removeNamed", { name: member.name })}
            onClick={() => onRemoveMember({ userId: member.userId, name: member.name })}
          />
        ) : null}
      </div>
    </div>
  );
}
