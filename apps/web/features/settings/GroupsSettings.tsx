"use client";

import { isGuestsOnly } from "./guestLogic.ts";
import { type CSSProperties, useState } from "react";
import { Avatar, Button, Card, Dialog, Field, Icon, Input, Tag } from "@/components/ds";
import { GROUP_NAME_MAX } from "@ruchoir/client/permissionsLogic";
import { CharCount } from "./CharCount";
import type { Member } from "@/lib/data/api";
import { createGroup, refusalOf } from "@/lib/data/api";
import type { Group, Role, SpaceEdition } from "@/lib/data/types";
import { getAvatar } from "@/lib/data";
import { useTranslation } from "@/lib/i18n";
import type { Toast } from "../app/types";
import { GroupIcon } from "../groups/GroupIcon";
import { GroupEditor } from "./GroupEditor";
import { GROUP_DESCRIPTION_MAX, groupPeople, groupRow, foldName, sortGroups } from "./groupsLogic.ts";
import { importedGroupSource } from "./importLogic.ts";
import { refusalMessage, RoleChip, roleLabel } from "./roleChips";

const st: Record<string, CSSProperties> = {
  h: { fontSize: "clamp(28px, 3.4vw, 40px)", fontWeight: 700, letterSpacing: "var(--tracking-display)", lineHeight: 1.05, color: "var(--text-strong)", marginBottom: 10 },
  sub: { fontSize: "var(--text-md)", color: "var(--text-body)", marginBottom: 20 },
  tools: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 14 },
  muted: { fontSize: "var(--text-xs)", color: "var(--text-muted)" },
  head: { display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", fontFamily: "var(--label-font)", fontSize: "var(--text-2xs)", color: "var(--text-muted)" },
  row: { display: "flex", alignItems: "center", gap: 10, padding: "11px 14px", background: "var(--surface-raised)" },
  name: { flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 10 },
  title: { display: "flex", alignItems: "center", gap: 8, fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--text-strong)" },
  desc: { fontSize: "var(--text-xs)", color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  people: { width: 120, flex: "none", display: "flex", alignItems: "center", gap: 8, fontSize: "var(--text-xs)", color: "var(--text-body)" },
  roles: { width: 170, flex: "none", display: "flex", flexWrap: "wrap", gap: 4, fontSize: "var(--text-xs)", color: "var(--text-muted)" },
  managers: { width: 140, flex: "none", display: "flex", flexDirection: "column", gap: 3, fontSize: "var(--text-xs)", color: "var(--text-body)" },
  end: { width: 54, flex: "none", display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 5, fontSize: "var(--text-2xs)", color: "var(--text-muted)" },
  note: { display: "flex", gap: 8, alignItems: "flex-start", fontSize: "var(--text-xs)", color: "var(--text-muted)", marginTop: 12, lineHeight: "var(--leading-snug)" },
  upsell: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 18,
    padding: "12px 14px",
    border: "1px dashed var(--border-default)",
    borderRadius: "var(--radius-md)",
    fontSize: "var(--text-xs)",
    color: "var(--text-body)",
  },
};

export type GroupsSettingsProps = {
  spaceId: string;
  spaceName: string;
  edition: SpaceEdition;
  /** The space's roles, strongest first, base roles last. */
  roles: Role[];
  members: Member[];
  /** The space's groups, kept by the app. */
  groups: Group[];
  me?: Member;
  pricingUrl?: string;
  /** Roles or their holders may have changed: read them again. */
  onChanged: () => Promise<void>;
  onNotify: (toast: Toast) => void;
  /** A group to open at once (from a role's people), instead of the list. */
  initialGroupId?: string | null;
};

/**
 * The Groupes tab. It draws the space's groups the app keeps (read again after each write and on
 * every change of permissions, wherever it comes from); the
 * list is the community one (people only, one discreet line about more) or the licensed one (roles
 * carried and managers too).
 */
export function GroupsSettings(props: GroupsSettingsProps) {
  const { t } = useTranslation();
  const { spaceId, edition, onNotify, groups } = props;
  const [editing, setEditing] = useState<string | null>(props.initialGroupId ?? null);

  // The space's groups are the app's own list, read again after each write and when permissions
  // change elsewhere: this tab keeps no copy of its own.
  const changed = () => props.onChanged();

  const group = editing ? groups.find((g) => g.id === editing) : undefined;
  if (group) {
    return (
      <GroupEditor
        // Keyed on the group alone: a write reads it again without sending the editor back to its first tab.
        key={group.id}
        spaceId={spaceId}
        group={group}
        edition={edition}
        roles={props.roles}
        members={props.members}
        me={props.me}
        onBack={() => setEditing(null)}
        onChanged={changed}
        onNotify={onNotify}
      />
    );
  }
  return <GroupList {...props} groups={groups} onOpen={setEditing} onCreated={async (id, name) => {
          await changed();
          onNotify({ tone: "success", title: t("groups.created"), description: name });
          setEditing(id);
        }} />;
}

function GroupList({
  spaceId,
  edition,
  roles,
  members,
  pricingUrl,
  groups,
  onOpen,
  onCreated,
}: GroupsSettingsProps & { onOpen: (id: string) => void; onCreated: (id: string, name: string) => Promise<void> }) {
  const { t } = useTranslation();
  const licensed = edition !== "community";
  const frozen = edition === "frozen";
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const byId = new Map(members.map((m) => [m.userId, m]));
  const needle = foldName(query.trim());
  const shown = sortGroups(groups).filter((g) => foldName(g.name).includes(needle));
  const lockedAbove = licensed
    ? sortGroups(groups)
        .map((g) => ({ g, row: groupRow(g, roles, { frozen }) }))
        .find((x) => x.row.locked === "above")
    : undefined;

  return (
    <>
      <h2 style={st.h}>{t("groups.title")}</h2>
      <p style={st.sub}>{licensed ? t("groups.subLicensed") : t("groups.sub")}</p>
      {frozen ? <p style={{ ...st.muted, margin: "0 0 12px" }}>{t("groups.frozenNote")}</p> : null}
      <div style={st.tools}>
        {frozen ? null : (
          <div style={{ width: 280 }}>
            <Input size="sm" icon="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("groups.search")} aria-label={t("groups.search")} />
          </div>
        )}
        <span style={{ flex: 1 }} />
        <Button size="sm" variant="primary" iconLeft="plus" onClick={() => setCreating(true)}>
          {t("groups.create")}
        </Button>
      </div>
      {groups.length === 0 ? (
        <p style={st.muted}>{t("groups.empty")}</p>
      ) : (
        <Card>
          <div style={st.head}>
            <span style={{ width: 36 }} />
            <span style={{ ...st.name, display: "block", fontWeight: 400 }}>{t("groups.colGroup")}</span>
            <span style={st.people}>{t("gsearch.people")}</span>
            {licensed ? <span style={st.roles}>{t("groups.colRoles")}</span> : null}
            {licensed ? <span style={st.managers}>{t("groups.colManagers")}</span> : null}
            <span style={st.end} />
          </div>
          {shown.length === 0 ? (
            <div style={{ ...st.row, ...st.muted }}>{t("search.noResult")}</div>
          ) : (
            shown.map((g, i) => {
              const row = groupRow(g, roles, { frozen });
              const opens = row.locked !== "above" || Object.entries(g.may).some(([key, allowed]) => key !== "addNeedsLicence" && allowed);
              const { people } = groupPeople(g, members);
              const managers = g.managerIds.map((id) => byId.get(id)).filter((m): m is Member => !!m);
              return (
                <div
                  key={g.id}
                  role={opens ? "button" : undefined}
                  tabIndex={opens ? 0 : undefined}
                  onClick={opens ? () => onOpen(g.id) : undefined}
                  onKeyDown={opens ? (e) => (e.key === "Enter" || e.key === " ") && onOpen(g.id) : undefined}
                  style={{ ...st.row, borderTop: i ? "1px solid var(--border-subtle)" : "none", cursor: opens ? "pointer" : "default" }}
                >
                  <GroupIcon id={g.id} />
                  <span style={{ ...st.name, flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
                    <span style={st.title}>
                      {g.name}
                      {g.source === "directory" ? <Tag icon="refresh-cw">{t("groups.directoryTag")}</Tag> : null}
                      {isGuestsOnly(g, members) ? <Tag tone="warning">{t("guests.sectionTitle")}</Tag> : null}
                    </span>
                    {g.description ? (
                      <span style={{ ...st.desc, maxWidth: "100%" }}>{g.description}</span>
                    ) : importedGroupSource(g) ? (
                      <span style={{ ...st.desc, maxWidth: "100%" }}>{t("groups.importedFrom", { source: importedGroupSource(g) ?? "" })}</span>
                    ) : null}
                  </span>
                  <span style={st.people}>
                    <span style={{ display: "flex" }}>
                      {people.slice(0, 3).map((m, k) => (
                        <Avatar key={m.userId} name={m.name} src={m.avatarUrl ?? getAvatar(m.name)} size={22} style={{ marginLeft: k ? -6 : 0 }} />
                      ))}
                    </span>
                    {people.length}
                  </span>
                  {licensed ? (
                    <span style={st.roles}>
                      {row.carries.length === 0 ? t("groups.noRole") : row.carries.map((r) => <RoleChip key={r.id} role={r} />)}
                    </span>
                  ) : null}
                  {licensed ? (
                    <span style={st.managers}>
                      {g.source === "directory"
                        ? t("groups.directoryDecides")
                        : managers.map((m) => (
                            <span key={m.userId} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <Avatar name={m.name} src={m.avatarUrl ?? getAvatar(m.name)} size={18} />
                              {m.name.split(" ")[0]}
                            </span>
                          ))}
                    </span>
                  ) : null}
                  <span style={st.end}>
                    {row.locked === "above" ? (
                      <Icon name="lock" size={14} />
                    ) : row.locked === "frozen" ? (
                      <>
                        <Icon name="clock" size={13} />
                        {t("roles.frozenShort")}
                      </>
                    ) : (
                      <Icon name="chevron-right" size={16} />
                    )}
                  </span>
                </div>
              );
            })
          )}
        </Card>
      )}
      {lockedAbove ? (
        <div style={st.note}>
          <Icon name="lock" size={13} style={{ marginTop: 2 }} />
          <span>
            {t("groups.lockedAbove", {
              group: lockedAbove.g.name,
              roles: lockedAbove.row.carries.map((r) => roleLabel(r, t)).join(", "),
            })}
          </span>
        </div>
      ) : null}
      {licensed ? null : (
        <div style={st.upsell}>
          <Icon name="star" size={15} style={{ color: "var(--text-muted)" }} />
          <span style={{ flex: 1, minWidth: 200 }}>
            <b>{t("groups.upsellStrong")}</b> {t("groups.upsellRest")}
          </span>
          {pricingUrl ? (
            <a className="wc-btn wc-btn--link wc-btn--sm" href={pricingUrl} target="_blank" rel="noreferrer">
              {t("roles.seePricing")}
              <Icon name="external-link" size={13} />
            </a>
          ) : null}
        </div>
      )}
      {creating ? (
        <CreateGroupDialog
          spaceId={spaceId}
          onClose={() => setCreating(false)}
          onCreated={async (id, name) => {
            setCreating(false);
            await onCreated(id, name);
          }}
        />
      ) : null}
    </>
  );
}

/** A new group: a name (which is also what is mentioned) and an optional description. */
function CreateGroupDialog({ spaceId, onClose, onCreated }: { spaceId: string; onClose: () => void; onCreated: (id: string, name: string) => Promise<void> }) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const create = async () => {
    setBusy(true);
    setError("");
    try {
      const group = await createGroup(spaceId, { name: name.trim(), description: description.trim() || undefined });
      await onCreated(group.id, group.name);
    } catch (err) {
      setError(refusalMessage(refusalOf(err), t, t("roles.saveFailed")));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={t("groups.create")}
      subtitle={t("groups.createSub")}
      onClose={onClose}
      closeLabel={t("common.close")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" disabled={busy || !name.trim()} onClick={() => void create()}>
            {busy ? t("common.creating") : t("groups.createAndAdd")}
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <Field label={t("files.name")} htmlFor="new-group-name" error={error || undefined} hint={name.trim() ? t("groups.nameHint", { name: name.trim() }) : undefined}>
          <Input id="new-group-name" value={name} maxLength={GROUP_NAME_MAX} autoFocus onChange={(e) => setName(e.target.value)} />
          <CharCount value={name} max={GROUP_NAME_MAX} />
        </Field>
        <Field label={t("groups.descOptional")} htmlFor="new-group-desc">
          <Input id="new-group-desc" value={description} maxLength={GROUP_DESCRIPTION_MAX} onChange={(e) => setDescription(e.target.value)} />
          <CharCount value={description} max={GROUP_DESCRIPTION_MAX} />
        </Field>
      </div>
    </Dialog>
  );
}
