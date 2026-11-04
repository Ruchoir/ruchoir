"use client";

import { type CSSProperties, useState } from "react";
import { Avatar, Button, Card, Field, Icon, IconButton, Input, Switch, Tabs, Tag } from "@/components/ds";
import { GROUP_NAME_MAX } from "@ruchoir/client/permissionsLogic";
import { CharCount } from "./CharCount";
import type { Member } from "@/lib/data/api";
import { refusalOf, removeGroupMember, setGroupManagers, updateGroup } from "@/lib/data/api";
import type { Group, Role, SpaceEdition } from "@/lib/data/types";
import { getAvatar } from "@/lib/data";
import { useTranslation } from "@/lib/i18n";
import type { Toast } from "../app/types";
import { AddPeopleDialog } from "../groups/AddPeopleDialog";
import { offersManagement, removalOf } from "../groups/groupPanelLogic.ts";
import { GroupIcon } from "../groups/GroupIcon";
import { DeleteGroupDialog } from "./GroupDialogs";
import { GroupRolesTab } from "./GroupRolesTab";
import { GROUP_DESCRIPTION_MAX, foldName, groupPeople, groupRow } from "./groupsLogic.ts";
import { refusalMessage, roleLabel } from "./roleChips";

const st: Record<string, CSSProperties> = {
  crumb: { display: "flex", alignItems: "center", gap: 6, fontSize: "var(--text-xs)", color: "var(--text-muted)", marginBottom: 14 },
  head: { display: "flex", alignItems: "center", gap: 14, marginBottom: 18 },
  h: { fontSize: "clamp(24px, 3vw, 34px)", fontWeight: 700, letterSpacing: "var(--tracking-display)", lineHeight: 1.05, color: "var(--text-strong)", margin: 0 },
  sub: { fontSize: "var(--text-sm)", color: "var(--text-muted)", margin: "4px 0 0" },
  info: { display: "flex", gap: 8, alignItems: "flex-start", fontSize: "var(--text-xs)", color: "var(--text-body)", margin: "16px 0 12px", lineHeight: "var(--leading-snug)" },
  alert: {
    display: "flex",
    gap: 8,
    alignItems: "flex-start",
    margin: "16px 0 12px",
    padding: "12px 14px",
    background: "var(--surface-sunken)",
    border: "1px solid var(--border-default)",
    borderRadius: "var(--radius-md)",
    fontSize: "var(--text-xs)",
    color: "var(--text-body)",
    lineHeight: "var(--leading-snug)",
  },
  person: { display: "flex", alignItems: "center", gap: 12, padding: "10px 14px" },
};

export type GroupEditorProps = {
  spaceId: string;
  group: Group;
  edition: SpaceEdition;
  roles: Role[];
  members: Member[];
  me?: Member;
  onBack: () => void;
  /** The group or what hangs on it changed: read it again. */
  onChanged: () => Promise<void>;
  onNotify: (toast: Toast) => void;
};

/** One group: its people (and managers), the roles it carries, its name and description. */
export function GroupEditor({ spaceId, group, edition, roles, members, me, onBack, onChanged, onNotify }: GroupEditorProps) {
  const { t } = useTranslation();
  const licensed = edition !== "community";
  const frozen = edition === "frozen";
  const directory = group.source === "directory";
  const [tab, setTab] = useState("people");
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(group.name);
  const [description, setDescription] = useState(group.description ?? "");
  const [nameError, setNameError] = useState("");
  // The group is read again after each write and this editor stays mounted (so the tab stays), so
  // the drafts follow what was saved: adjusted while rendering, as React recommends.
  const saved = `${group.name}\n${group.description ?? ""}`;
  const [seen, setSeen] = useState(saved);
  if (seen !== saved) {
    setSeen(saved);
    setName(group.name);
    setDescription(group.description ?? "");
  }
  const { carries } = groupRow(group, roles, { frozen });
  const { people, missing } = groupPeople(group, members);
  const viewerId = me?.userId ?? "";
  const needle = foldName(query.trim());
  const shown = people.filter((m) => foldName(m.name).includes(needle));
  const peopleLabel = t("message.reactors", { count: people.length });

  const failed = (err: unknown) =>
    onNotify({ tone: "danger", title: t("roles.saveFailed"), description: refusalMessage(refusalOf(err), t, t("space.retry"), "members") });

  const setManager = async (userId: string, on: boolean) => {
    setBusy(true);
    try {
      const next = on ? [...group.managerIds, userId] : group.managerIds.filter((id) => id !== userId);
      await setGroupManagers(spaceId, group.id, next);
      await onChanged();
    } catch (err) {
      failed(err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (userId: string) => {
    setBusy(true);
    try {
      await removeGroupMember(spaceId, group.id, userId);
      await onChanged();
    } catch (err) {
      failed(err);
    } finally {
      setBusy(false);
    }
  };

  const saveName = async () => {
    setBusy(true);
    setNameError("");
    try {
      await updateGroup(spaceId, group.id, { name: name.trim(), description: description.trim() });
      await onChanged();
      onNotify({ tone: "success", title: t("groups.saved"), description: name.trim() });
    } catch (err) {
      const refusal = refusalOf(err);
      if (refusal) setNameError(refusalMessage(refusal, t, ""));
      else failed(err);
    } finally {
      setBusy(false);
    }
  };

  const tabs = [
    { value: "people", label: t("gsearch.people"), count: people.length },
    ...(licensed ? [{ value: "roles", label: t("roles.title"), count: group.roleIds.length }] : []),
    { value: "name", label: t("groups.tabName") },
  ];
  const nameDirty = name.trim() !== group.name || description.trim() !== (group.description ?? "");

  return (
    <div>
      <div style={st.crumb}>
        <Button size="sm" variant="link" iconLeft="arrow-left" onClick={onBack}>
          {t("groups.title")}
        </Button>
        <span>/</span>
        <span>{group.name}</span>
      </div>
      <div style={st.head}>
        <GroupIcon id={group.id} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={st.h}>{group.name}</h2>
          <p style={st.sub}>{group.description ? t("groups.headSub", { description: group.description, people: peopleLabel }) : peopleLabel}</p>
        </div>
        {group.may.delete ? (
          <Button size="sm" variant="ghost" iconLeft="trash-2" onClick={() => setDeleting(true)}>
            {t("groups.delete")}
          </Button>
        ) : null}
      </div>
      <Tabs items={tabs} value={tab} onChange={setTab} />

      {tab === "people" ? (
        <>
          {directory ? (
            <div style={{ ...st.alert, background: "var(--status-info-bg)", border: "1px solid var(--status-info-border)" }}>
              <Icon name="refresh-cw" size={14} style={{ marginTop: 1, color: "var(--status-info-fg)" }} />
              <span>
                <b>{t("groups.directoryAlertStrong")}</b> {t("groups.directoryAlertRest")}
              </span>
            </div>
          ) : licensed && carries.length > 0 ? (
            <div style={st.info}>
              <Icon name="info" size={14} style={{ color: "var(--text-muted)", marginTop: 1 }} />
              <span>{t("groups.carriesNote", { count: carries.length, roles: carries.map((r) => roleLabel(r, t)).join(", ") })}</span>
            </div>
          ) : null}
          <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "12px 0" }}>
            <div style={{ width: 280 }}>
              <Input size="sm" icon="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("groups.searchIn")} aria-label={t("groups.searchIn")} />
            </div>
            <span style={{ flex: 1 }} />
            {offersManagement(group) ? (
              <Button size="sm" variant="primary" iconLeft="user-plus" onClick={() => setAdding(true)}>
                {t("groups.addPeople")}
              </Button>
            ) : null}
          </div>
          <Card>
            {shown.length === 0 ? (
              <div style={{ ...st.person, color: "var(--text-muted)", fontSize: "var(--text-xs)" }}>{t("search.noResult")}</div>
            ) : (
              shown.map((m, i) => {
                const manager = group.managerIds.includes(m.userId);
                return (
                  <div key={m.userId} style={{ ...st.person, borderTop: i ? "1px solid var(--border-subtle)" : "none" }}>
                    <Avatar name={m.name} src={m.avatarUrl ?? getAvatar(m.name)} size={32} />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--text-strong)" }}>
                        {m.name}
                        {manager ? <Tag tone="accent" icon="shield">{t("groups.manager")}</Tag> : null}
                        {m.role === "owner" ? <Tag icon="star">{t("role.owner")}</Tag> : null}
                      </div>
                      {m.title ? <div style={{ fontSize: "var(--text-2xs)", color: "var(--text-muted)" }}>{m.title}</div> : null}
                    </span>
                    {directory ? (
                      <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: "var(--text-2xs)", color: "var(--text-muted)" }}>
                        <Icon name="refresh-cw" size={13} />
                        {t("groups.directoryTag")}
                      </span>
                    ) : (
                      <>
                        {licensed && m.role !== "guest" ? (
                          <Switch
                            label={t("groups.manager")}
                            aria-label={t("groups.managerOf", { group: group.name, name: m.name })}
                            checked={manager}
                            disabled={!group.may.appoint || frozen || busy}
                            onChange={(e) => void setManager(m.userId, e.target.checked)}
                          />
                        ) : null}
                        {removalOf(group, viewerId, m.userId).removable ? (
                          <IconButton icon="user-minus" size="sm" label={t("groups.removeFrom", { name: m.name })} disabled={busy} onClick={() => void remove(m.userId)} />
                        ) : null}
                      </>
                    )}
                  </div>
                );
              })
            )}
          </Card>
          {missing > 0 ? <div style={{ ...st.info, margin: "10px 0 0" }}>{t("audit.formerMembers", { count: missing })}</div> : null}
        </>
      ) : null}

      {tab === "roles" && licensed ? (
        <GroupRolesTab key={group.roleIds.join(",")} spaceId={spaceId} group={group} roles={roles} me={me} frozen={frozen} onChanged={onChanged} onNotify={onNotify} />
      ) : null}

      {tab === "name" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 420, marginTop: 16 }}>
          <Field label={t("files.name")} htmlFor="group-name" error={nameError || undefined} hint={t("groups.nameHint", { name: name.trim() || group.name })}>
            <Input id="group-name" value={name} maxLength={GROUP_NAME_MAX} disabled={!group.may.edit || busy} onChange={(e) => setName(e.target.value)} />
            <CharCount value={name} max={GROUP_NAME_MAX} />
          </Field>
          <Field label={t("groups.descOptional")} htmlFor="group-desc">
            <Input id="group-desc" value={description} maxLength={GROUP_DESCRIPTION_MAX} disabled={!group.may.edit || busy} onChange={(e) => setDescription(e.target.value)} />
            <CharCount value={description} max={GROUP_DESCRIPTION_MAX} />
          </Field>
          {group.may.edit ? (
            <div>
              <Button size="sm" variant="primary" disabled={busy || !name.trim() || !nameDirty} onClick={() => void saveName()}>
                {busy ? t("common.sending") : t("common.save")}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {adding ? <AddPeopleDialog spaceId={spaceId} group={group} members={members} carries={licensed ? carries : []} viewerId={viewerId} viewerIsOwner={me?.role === "owner"} onClose={() => setAdding(false)} onChanged={onChanged} onNotify={onNotify} /> : null}
      {deleting ? (
        <DeleteGroupDialog spaceId={spaceId} group={group} carries={licensed ? carries : []} onClose={() => setDeleting(false)} onChanged={onChanged} onNotify={onNotify} onDeleted={onBack} />
      ) : null}
    </div>
  );
}
