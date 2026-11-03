"use client";

import { type CSSProperties, type ReactNode, useState } from "react";
import { Avatar, Button, Icon, IconButton, Tabs, Tag, Tooltip } from "@/components/ds";
import { getAvatar } from "@/lib/data";
import type { Member } from "@/lib/data/api";
import { refusalOf, removeGroupMember } from "@/lib/data/api";
import type { Group, Role, SpaceEdition } from "@/lib/data/types";
import { useTranslation } from "@/lib/i18n";
import type { Toast } from "../app/types";
import { groupColour, GroupIcon } from "../settings/GroupEditor";
import { AddPeopleDialog } from "../settings/GroupDialogs";
import { refusalMessage, RoleChip, roleLabel } from "../settings/MemberAccess";
import { isManagerOf, offersLeaving, offersManagement, removalOf } from "./groupPanelLogic.ts";
import { PanelHead } from "./PanelHead";

const st: Record<string, CSSProperties> = {
  panel: {
    width: "var(--panel-width)",
    flex: "none",
    borderLeft: "1.5px solid var(--border-subtle)",
    background: "var(--surface-chrome)",
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
  },
  scroll: { flex: 1, overflow: "auto" },
  hero: { display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 6, padding: "28px 16px 18px", borderBottom: "2px solid var(--on-pastel)" },
  section: { padding: "14px 16px", borderBottom: "1px solid var(--border-subtle)" },
  label: { fontFamily: "var(--label-font)", fontSize: "var(--text-2xs)", fontWeight: 500, color: "var(--text-muted)", marginBottom: 8 },
  person: { display: "flex", alignItems: "center", gap: 10, padding: "7px 0" },
  name: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--text-strong)" },
  sub: { fontSize: "var(--text-2xs)", color: "var(--text-muted)" },
  note: { display: "flex", gap: 8, alignItems: "flex-start", fontSize: "var(--text-xs)", color: "var(--text-body)", lineHeight: "var(--leading-snug)" },
};

export type GroupPanelProps = {
  spaceId: string;
  group: Group;
  edition: SpaceEdition;
  roles: Role[];
  /** The space's people, which the group's ids are read against. */
  members: Member[];
  viewerId: string;
  onClose: () => void;
  /** The group changed: the space's groups are read again. */
  onChanged: () => Promise<void>;
  onNotify: (toast: Toast) => void;
};

/**
 * One group in the conversation's right panel: who is in it and what its members receive, and for
 * its managers (or whoever changes members space-wide) a "Gestion" tab to add and remove people.
 * The API judges every change; the panel only leaves out what it would refuse.
 */
export function GroupPanel({ spaceId, group, edition, roles, members, viewerId, onClose, onChanged, onNotify }: GroupPanelProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"group" | "manage">("group");
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const licensed = edition !== "community";
  const manage = offersManagement(group, viewerId);
  const managing = manage && tab === "manage";
  const carries = roles.filter((r) => group.roleIds.includes(r.id));
  const byId = new Map(members.map((m) => [m.userId, m]));
  const people = group.memberIds.map((id) => byId.get(id)).filter((m): m is Member => !!m);
  const managersFirst = [...people].sort((a, b) => Number(group.managerIds.includes(b.userId)) - Number(group.managerIds.includes(a.userId)));

  const failed = (err: unknown) =>
    onNotify({ tone: "danger", title: t("roles.saveFailed"), description: refusalMessage(refusalOf(err), t, t("space.retry")) });

  const write = async (action: () => Promise<unknown>, done: string, then?: () => void) => {
    setBusy(true);
    try {
      await action();
      await onChanged();
      onNotify({ tone: "success", title: done, description: group.name });
      then?.();
    } catch (err) {
      failed(err);
    } finally {
      setBusy(false);
    }
  };

  const row = (m: Member, trailing: ReactNode) => {
    const manager = group.managerIds.includes(m.userId);
    return (
      <div key={m.userId} style={st.person}>
        <Avatar name={m.name} src={m.avatarUrl ?? getAvatar(m.name)} size={32} />
        <span style={{ flex: 1, minWidth: 0 }}>
          <div style={st.name}>
            {m.name}
            {manager ? (
              <Tag tone="accent" icon="shield">
                {t("groups.manager")}
              </Tag>
            ) : null}
          </div>
          {m.title ? <div style={st.sub}>{m.title}</div> : null}
        </span>
        {trailing}
      </div>
    );
  };

  // Offered under "Gestion" to those who have it, and on the group itself to those who do not.
  const leaveButton = offersLeaving(group, viewerId) ? (
    <div style={{ padding: "10px 16px" }}>
      <Button
        size="sm"
        variant="ghost"
        iconLeft="log-out"
        disabled={busy}
        onClick={() => void write(() => removeGroupMember(spaceId, group.id, viewerId), t("groups.left"), onClose)}
      >
        {t("groups.leave")}
      </Button>
    </div>
  ) : null;

  const header = (
    <div style={{ ...st.section, display: "flex", alignItems: "center", gap: 12 }}>
      <GroupIcon id={group.id} size={40} />
      <span style={{ minWidth: 0 }}>
        <div style={{ ...st.name, fontSize: "var(--text-base)" }}>{group.name}</div>
        <div style={st.sub}>{isManagerOf(group, viewerId) ? t("groups.youManage") : (group.description ?? "")}</div>
      </span>
    </div>
  );

  return (
    <div style={st.panel}>
      <PanelHead title={t("groups.colGroup")} closeLabel={t("groups.close")} onClose={onClose} />
      {manage ? (
        <div style={{ flex: "none", padding: "0 12px", borderBottom: "1px solid var(--border-subtle)" }}>
          <Tabs
            items={[
              { value: "group", label: t("groups.colGroup") },
              { value: "manage", label: t("profile.tabManage") },
            ]}
            value={tab}
            onChange={(value) => setTab(value === "manage" ? "manage" : "group")}
          />
        </div>
      ) : null}

      {!managing ? (
        <div style={st.scroll}>
          <div style={{ ...st.hero, background: `var(--${groupColour(group.id)})` }} className="wc-pastel">
            <GroupIcon id={group.id} size={56} />
            <div style={{ fontSize: "var(--text-xl)", fontWeight: 700, letterSpacing: "var(--tracking-tight)" }}>{group.name}</div>
            {group.description ? <div style={{ fontSize: "var(--text-xs)" }}>{group.description}</div> : null}
          </div>
          {licensed && carries.length > 0 ? (
            <div style={st.section}>
              <div style={st.label}>{t("groups.membersReceive")}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {carries.map((r) => (
                  <RoleChip key={r.id} role={r} />
                ))}
              </div>
            </div>
          ) : null}
          <div style={st.section}>
            <div style={st.label}>{t("groups.peopleHead", { count: people.length })}</div>
            {people.length === 0 ? <div style={st.sub}>{t("groups.nobody")}</div> : managersFirst.map((m) => row(m, null))}
          </div>
          <div style={{ ...st.section, ...st.note }}>
            <Icon name="at-sign" size={14} style={{ color: "var(--text-muted)", marginTop: 1, flex: "none" }} />
            <span>{t("groups.mentionHint", { name: group.name })}</span>
          </div>
          {manage ? null : leaveButton}
        </div>
      ) : (
        <div style={st.scroll}>
          {header}
          <div style={st.section}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
              <div style={{ ...st.label, marginBottom: 0 }}>{t("groups.peopleHead", { count: people.length })}</div>
              {group.may.changeMembers || isManagerOf(group, viewerId) ? (
                <Button size="sm" variant="secondary" iconLeft="user-plus" disabled={busy} onClick={() => setAdding(true)}>
                  {t("groups.addPeople")}
                </Button>
              ) : null}
            </div>
            {managersFirst.map((m) => {
              const removal = removalOf(group, viewerId, m.userId);
              let trailing: ReactNode = null;
              if (removal.removable) {
                trailing = (
                  <IconButton
                    icon="user-minus"
                    size="sm"
                    disabled={busy}
                    label={t("groups.removeFrom", { name: m.name })}
                    onClick={() => void write(() => removeGroupMember(spaceId, group.id, m.userId), t("groups.personRemoved"))}
                  />
                );
              } else if (removal.reason === "self") {
                trailing = <span style={st.sub}>{t("groups.you")}</span>;
              } else if (removal.reason === "manager_protected") {
                trailing = (
                  <Tooltip label={t("groups.refusal.managerProtected")}>
                    <Icon name="lock" size={14} aria-label={t("groups.refusal.managerProtected")} style={{ color: "var(--text-muted)" }} />
                  </Tooltip>
                );
              }
              return row(m, trailing);
            })}
          </div>
          <div style={{ ...st.section, ...st.note }}>
            <Icon name="info" size={14} style={{ color: "var(--text-muted)", marginTop: 1, flex: "none" }} />
            <span>
              {licensed && carries.length > 0
                ? t("groups.carriesNote", { count: carries.length, roles: carries.map((r) => roleLabel(r, t)).join(", ") })
                : t("groups.manageNote")}
            </span>
          </div>
{leaveButton}
        </div>
      )}
      {adding ? (
        <AddPeopleDialog
          spaceId={spaceId}
          group={group}
          members={members}
          carries={licensed ? carries : []}
          onClose={() => setAdding(false)}
          onChanged={onChanged}
          onNotify={onNotify}
        />
      ) : null}
    </div>
  );
}

