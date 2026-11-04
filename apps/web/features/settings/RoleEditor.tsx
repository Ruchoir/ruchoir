"use client";

import { CeilingSummary } from "./CeilingSummary";
import { type CSSProperties, useState } from "react";
import { Avatar, Button, Card, Dialog, Field, Icon, IconButton, Input, Select, Switch, Tabs, Tag } from "@/components/ds";
import type { Member } from "@/lib/data/api";
import { deleteRole, refusalOf, updateRole } from "@/lib/data/api";
import type { Group, Role, UsedIn } from "@/lib/data/types";
import { getAvatar } from "@/lib/data";
import { formatList } from "@/lib/i18n/format";
import { key, type TranslationKey, useTranslation } from "@/lib/i18n";
import { viewAsState } from "../app/previewLogic.ts";
import type { Toast } from "../app/types";
import { GroupIcon } from "../groups/GroupIcon";
import { rolePeople } from "./groupsLogic.ts";
import { refusalMessage, roleColour, roleLabel } from "./roleChips";
import { FAMILY_TEXT, PERMISSION_TEXT } from "./permissionText";
import { UsedInDialog } from "./UsedInDialog";
import { startViewAs } from "./viewAs";
import { changedPermissions, FAMILIES, GUEST_CEILING, permissionRow } from "./rolesLogic";

/** The pastels a role may wear (`ROLE_COLOURS` in `apps/api/src/permissions/roles.rs`). */
export const ROLE_COLOURS = ["sky", "mint", "violet", "pink", "peach", "lime", "sun"];

/** Each pastel's name, for a screen reader. */
const COLOUR_TEXT: Record<string, TranslationKey> = {
  sky: key("prefs.themeSky"),
  mint: key("prefs.themeMint"),
  violet: key("prefs.themeViolet"),
  pink: key("prefs.themePink"),
  peach: key("calendar.color.peach"),
  lime: key("calendar.color.lime"),
  sun: key("calendar.color.sun"),
};

const CATALOGUE = FAMILIES.flatMap((f) => f.permissions);

const st: Record<string, CSSProperties> = {
  crumb: { display: "flex", alignItems: "center", gap: 6, fontSize: "var(--text-xs)", color: "var(--text-muted)", marginBottom: 14 },
  head: { display: "flex", alignItems: "center", gap: 14, marginBottom: 18 },
  h: { fontSize: "clamp(24px, 3vw, 34px)", fontWeight: 700, letterSpacing: "var(--tracking-display)", lineHeight: 1.05, color: "var(--text-strong)", margin: 0 },
  sub: { fontSize: "var(--text-sm)", color: "var(--text-muted)", margin: "4px 0 0" },
  intro: { display: "flex", gap: 8, alignItems: "flex-start", fontSize: "var(--text-xs)", color: "var(--text-body)", margin: "16px 0 6px", lineHeight: "var(--leading-snug)" },
  fam: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    border: 0,
    background: "transparent",
    padding: "18px 0 8px",
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-sm)",
    fontWeight: 600,
    color: "var(--text-strong)",
    cursor: "pointer",
    textAlign: "left",
  },
  famN: { fontSize: "var(--text-2xs)", fontWeight: 400, color: "var(--text-muted)", flex: 1 },
  prow: { display: "flex", alignItems: "center", gap: 14, padding: "12px 14px" },
  pt: { display: "flex", alignItems: "center", gap: 8, fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--text-strong)" },
  pd: { fontSize: "var(--text-2xs)", color: "var(--text-muted)", marginTop: 2 },
  hint: { display: "flex", alignItems: "center", gap: 5, fontSize: "var(--text-2xs)", color: "var(--text-muted)", marginTop: 4 },
  savebar: {
    position: "sticky",
    bottom: 0,
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 20,
    padding: "12px 14px",
    background: "var(--surface-raised)",
    border: "1.5px solid var(--border-default)",
    borderRadius: "var(--radius-md)",
    fontSize: "var(--text-xs)",
    color: "var(--text-body)",
  },
  sect: { fontFamily: "var(--label-font)", fontSize: "var(--text-2xs)", fontWeight: 500, color: "var(--text-muted)", marginBottom: 8 },
  person: { display: "flex", alignItems: "center", gap: 12, padding: "10px 14px" },
};

export type RoleEditorProps = {
  spaceId: string;
  role: Role;
  /** Every role of the space, strongest first. */
  roles: Role[];
  members: Member[];
  /** The space's groups: some of them give this role to their members. */
  groups: Group[];
  /** Opens a group in the Groupes tab; absent when the viewer does not manage groups. */
  onOpenGroup?: (groupId: string) => void;
  /** What the viewer holds in the space: rule 2, they give and take only that. */
  myRights: string[];
  frozen: boolean;
  onBack: () => void;
  /** The roles or the people changed: read them again. */
  onChanged: () => Promise<void>;
  /** Set one person's roles (strongest first); resolves to whether it was saved. */
  onSetMemberRoles: (userId: string, roleIds: string[]) => Promise<boolean>;
  onNotify: (toast: Toast) => void;
};

/** One role: its rights in plain sentences, the people holding it, its name and colour. */
export function RoleEditor({ spaceId, role, roles, members, groups, onOpenGroup, myRights, frozen, onBack, onChanged, onSetMemberRoles, onNotify }: RoleEditorProps) {
  const { t } = useTranslation();
  const custom = !role.systemKey;
  const [tab, setTab] = useState("rights");
  const [draft, setDraft] = useState<Set<string>>(() => new Set(role.permissions));
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** Where the role is named by rules, when the server refused the deletion for that. */
  const [usedIn, setUsedIn] = useState<UsedIn[] | null>(null);
  const [name, setName] = useState(role.name);
  const [colour, setColour] = useState(role.colour ?? "sky");
  const [nameError, setNameError] = useState("");
  const editable = role.manageable && !frozen;
  const membersBase = roles.find((r) => r.systemKey === "members")?.permissions ?? [];
  const ranked = roles.filter((r) => r.systemKey !== "members" && r.systemKey !== "guests");
  const above = custom ? ranked[ranked.findIndex((r) => r.id === role.id) - 1] : undefined;
  const base = role.systemKey === "guests" || role.systemKey === "members";
  const people = rolePeople(role.id, members, groups);
  // Everyone who holds it, once: given directly or through a group.
  const holders = role.systemKey === "guests" ? members.filter((m) => m.role === "guest") : base ? [] : members.filter((m) => people.holderIds.includes(m.userId));
  const viaGroups = base ? [] : people.viaGroups;
  const directHolders = role.systemKey === "guests" ? holders : people.direct;
  const after = CATALOGUE.filter((p) => draft.has(p));
  const changes = changedPermissions(role.permissions, after);
  const changeCount = changes.added.length + changes.removed.length;

  const toggle = (permission: string, on: boolean) =>
    setDraft((prev) => {
      const next = new Set(prev);
      if (on) next.add(permission);
      else next.delete(permission);
      return next;
    });

  const failed = (err: unknown) =>
    onNotify({ tone: "danger", title: t("roles.saveFailed"), description: refusalMessage(refusalOf(err), t, t("space.retry")) });

  const saveRights = async () => {
    setBusy(true);
    try {
      await updateRole(spaceId, role.id, { permissions: after });
      await onChanged();
      onNotify({ tone: "success", title: t("roles.saved"), description: roleLabel(role, t) });
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
      await updateRole(spaceId, role.id, { name: name.trim(), colour });
      await onChanged();
      onNotify({ tone: "success", title: t("roles.saved"), description: name.trim() });
    } catch (err) {
      const refusal = refusalOf(err);
      if (refusal) setNameError(refusalMessage(refusal, t, ""));
      else failed(err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await deleteRole(spaceId, role.id);
      setConfirmDelete(false);
      await onChanged();
      onNotify({ tone: "success", title: t("roles.deleted"), description: role.name });
      onBack();
    } catch (err) {
      setConfirmDelete(false);
      const refusal = refusalOf(err);
      if (refusal?.code === "role_has_rules" && refusal.usedIn) setUsedIn(refusal.usedIn);
      else failed(err);
    } finally {
      setBusy(false);
    }
  };

  /** Their roles with this one added or taken out, strongest first. */
  const withThisRole = (member: Member, on: boolean) => {
    const held = new Set(member.roleIds ?? []);
    if (on) held.add(role.id);
    else held.delete(role.id);
    return ranked.filter((r) => held.has(r.id)).map((r) => r.id);
  };
  const addable = members.filter((m) => m.manageable && !m.bot && !m.roleIds?.includes(role.id));

  const tabs = [
    { value: "rights", label: t("roles.tabRights") },
    ...(role.systemKey === "members" ? [] : [{ value: "people", label: t("gsearch.people"), count: holders.length }]),
    ...(custom ? [{ value: "name", label: t("roles.tabName") }] : []),
  ];

  return (
    <div>
      <div style={st.crumb}>
        <Button size="sm" variant="link" iconLeft="arrow-left" onClick={onBack}>
          {t("roles.title")}
        </Button>
        <span>/</span>
        <span>{roleLabel(role, t)}</span>
      </div>
      <div style={st.head}>
        <span aria-hidden style={{ width: 36, height: 36, flex: "none", borderRadius: "var(--radius-full)", background: roleColour(role), border: "1.5px solid var(--on-pastel)" }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={st.h}>{roleLabel(role, t)}</h2>
          <p style={st.sub}>
            {role.systemKey === "members"
              ? t("roles.baseEveryone")
              : role.systemKey === "guests"
                ? t("roles.baseGuests")
                : above
                  ? t("roles.belowAndPeople", { role: roleLabel(above, t), count: holders.length })
                  : t("message.reactors", { count: holders.length })}
          </p>
        </div>
        {viewAsState(role, { edition: frozen ? "frozen" : "enterprise", canManageRoles: myRights.includes("roles.manage") }) === "button" ? (
          <Button size="sm" variant="secondary" iconLeft="eye" onClick={() => void startViewAs(spaceId, role, onNotify, t)}>
            {t("preview.viewAs")}
          </Button>
        ) : null}
        {custom && editable ? (
          <Button size="sm" variant="ghost" iconLeft="trash-2" onClick={() => setConfirmDelete(true)}>
            {t("roles.delete")}
          </Button>
        ) : null}
      </div>
      <Tabs items={tabs} value={tab} onChange={setTab} />

      {tab === "rights" ? (
        <>
          <div style={st.intro}>
            <Icon name="info" size={14} style={{ color: "var(--text-muted)", marginTop: 1 }} />
            <span>{role.systemKey === "guests" ? t("roles.guestsIntro") : t("roles.rightsIntro")}</span>
          </div>
          {role.systemKey === "guests" ? (
            <div style={{ margin: "0 0 14px" }}>
              <CeilingSummary />
            </div>
          ) : null}
          {FAMILIES.map((family) => {
            const open = !closed.has(family.key);
            return (
              <div key={family.key}>
                <button
                  type="button"
                  style={st.fam}
                  aria-expanded={open}
                  onClick={() =>
                    setClosed((prev) => {
                      const next = new Set(prev);
                      if (open) next.add(family.key);
                      else next.delete(family.key);
                      return next;
                    })
                  }
                >
                  {t(FAMILY_TEXT[family.key])}
                  <span style={st.famN}>{t("roles.rightsCount", { count: family.permissions.length })}</span>
                  <Icon name={open ? "chevron-down" : "chevron-right"} size={14} style={{ color: "var(--text-muted)" }} />
                </button>
                {open ? (
                  <Card>
                    {family.permissions.map((permission, i) => {
                      const row = permissionRow(permission, { role, draft, viewerRights: myRights, membersBase });
                      const ceiling = role.systemKey === "guests" && GUEST_CEILING.has(permission);
                      const text = PERMISSION_TEXT[permission];
                      return (
                        <div
                          key={permission}
                          style={{
                            ...st.prow,
                            borderTop: i ? "1px solid var(--border-subtle)" : "none",
                            background: row.changed ? "var(--surface-sunken)" : undefined,
                          }}
                        >
                          <span style={{ flex: 1, minWidth: 0 }}>
                            <span style={st.pt}>
                              {t(text.title)}
                              {row.changed ? <Tag tone="accent">{t("files.modified")}</Tag> : null}
                            </span>
                            <div style={st.pd}>{t(text.desc)}</div>
                            {ceiling ? (
                              <div style={st.hint}>
                                <Icon name="lock" size={12} />
                                {t("roles.neverForGuests")}
                              </div>
                            ) : row.locked && editable ? (
                              <div style={st.hint}>
                                <Icon name="lock" size={12} />
                                {t("roles.notHeld")}
                              </div>
                            ) : null}
                            {row.givenByMembers ? <div style={st.hint}>{t("roles.givenByMembers")}</div> : null}
                          </span>
                          <Switch
                            aria-label={t(text.title)}
                            checked={row.on}
                            disabled={!editable || row.locked || ceiling || busy}
                            onChange={(e) => toggle(permission, e.target.checked)}
                          />
                        </div>
                      );
                    })}
                  </Card>
                ) : null}
              </div>
            );
          })}
          {changeCount > 0 ? (
            <div style={st.savebar}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <b>{t("roles.changes", { count: changeCount })}</b>
                {" : "}
                {[...changes.added, ...changes.removed].map((p) => t(PERMISSION_TEXT[p].title)).join(", ")}
              </span>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDraft(new Set(role.permissions))}>
                {t("common.cancel")}
              </Button>
              <Button size="sm" variant="primary" disabled={busy} onClick={() => void saveRights()}>
                {busy ? t("common.sending") : t("common.save")}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}

      {tab === "people" ? (
        <div style={{ marginTop: 16 }}>
          {role.systemKey === "guests" ? (
            <p style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)", marginBottom: 10 }}>{t("roles.everyGuestHolds")}</p>
          ) : editable && addable.length > 0 ? (
            <div style={{ width: 260, marginBottom: 12 }}>
              <Select
                size="sm"
                aria-label={t("roles.addPerson")}
                value=""
                onChange={(e) => {
                  const member = addable.find((m) => m.userId === e.target.value);
                  if (member) void onSetMemberRoles(member.userId, withThisRole(member, true));
                }}
                options={[{ value: "", label: t("roles.addPerson") }, ...addable.map((m) => ({ value: m.userId, label: m.name }))]}
              />
            </div>
          ) : null}
          {viaGroups.length > 0 ? <div style={st.sect}>{t("roles.directly")}</div> : null}
          <Card>
            {directHolders.length === 0 ? (
              <div style={{ ...st.person, color: "var(--text-muted)", fontSize: "var(--text-xs)" }}>
                {viaGroups.length > 0 ? t("roles.nobodyDirectly") : t("roles.nobodyHolds")}
              </div>
            ) : (
              directHolders.map((m, i) => (
                <div key={m.userId} style={{ ...st.person, borderTop: i ? "1px solid var(--border-subtle)" : "none" }}>
                  <Avatar name={m.name} src={m.avatarUrl ?? getAvatar(m.name)} size={28} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: "var(--text-xs)", fontWeight: 500, color: "var(--text-strong)" }}>{m.name}</div>
                    {m.title ? <div style={{ fontSize: "var(--text-2xs)", color: "var(--text-muted)" }}>{m.title}</div> : null}
                  </span>
                  {editable && role.systemKey !== "guests" && m.manageable ? (
                    <IconButton
                      icon="user-minus"
                      size="sm"
                      label={t("roles.takeAway", { name: m.name, role: roleLabel(role, t) })}
                      onClick={() => void onSetMemberRoles(m.userId, withThisRole(m, false))}
                    />
                  ) : null}
                </div>
              ))
            )}
          </Card>
          {viaGroups.length > 0 ? (
            <>
              <div style={{ ...st.sect, marginTop: 24 }}>{t("roles.viaGroup")}</div>
              <Card>
                {viaGroups.map(({ group, members: inGroup }, i) => (
                  <div key={group.id} style={{ ...st.person, borderTop: i ? "1px solid var(--border-subtle)" : "none" }}>
                    <GroupIcon id={group.id} size={32} />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: "var(--text-xs)", fontWeight: 500, color: "var(--text-strong)" }}>{group.name}</div>
                      <div style={{ fontSize: "var(--text-2xs)", color: "var(--text-muted)" }}>
                        {inGroup.length > 0 ? formatList(inGroup.map((m) => m.name)) : t("groups.nobody")}
                      </div>
                    </span>
                    <span style={{ fontSize: "var(--text-2xs)", color: "var(--text-muted)" }}>{t("space.members", { count: group.memberIds.length })}</span>
                    {onOpenGroup ? (
                      <Button size="sm" variant="link" onClick={() => onOpenGroup(group.id)}>
                        {t("groups.openGroup")}
                      </Button>
                    ) : null}
                  </div>
                ))}
              </Card>
              <div style={st.hint}>
                <Icon name="info" size={13} />
                {t("groups.roleFootnote")}
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {tab === "name" && custom ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 420, marginTop: 16 }}>
          <Field label={t("files.name")} htmlFor="role-name" error={nameError || undefined}>
            <Input id="role-name" value={name} disabled={!editable || busy} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t("calendar.colorLabel")}>
            <ColourPicker value={colour} onChange={setColour} disabled={!editable || busy} />
          </Field>
          {editable ? (
            <div>
              <Button
                size="sm"
                variant="primary"
                disabled={busy || !name.trim() || (name.trim() === role.name && colour === (role.colour ?? "sky"))}
                onClick={() => void saveName()}
              >
                {busy ? t("common.sending") : t("common.save")}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {usedIn ? <UsedInDialog of="role" name={role.name} usedIn={usedIn} onClose={() => setUsedIn(null)} /> : null}

      <Dialog
        open={confirmDelete}
        title={t("roles.deleteTitle", { role: role.name })}
        onClose={() => setConfirmDelete(false)}
        closeLabel={t("common.close")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              {t("common.cancel")}
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => void remove()}>
              {t("roles.delete")}
            </Button>
          </>
        }
      >
        <p style={{ fontSize: "var(--text-sm)", color: "var(--text-body)", lineHeight: "var(--leading-snug)" }}>
          {t("roles.deleteBody")}
        </p>
      </Dialog>
    </div>
  );
}

/** The seven pastels, one ticked. */
export function ColourPicker({ value, onChange, disabled }: { value: string; onChange: (colour: string) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  return (
    <div role="radiogroup" aria-label={t("calendar.colorLabel")} style={{ display: "flex", gap: 8 }}>
      {ROLE_COLOURS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={c === value}
          aria-label={t(COLOUR_TEXT[c])}
          disabled={disabled}
          onClick={() => onChange(c)}
          style={{
            width: 28,
            height: 28,
            borderRadius: "var(--radius-full)",
            background: `var(--${c})`,
            border: c === value ? "2px solid var(--on-pastel)" : "1.5px solid var(--border-subtle)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: disabled ? "default" : "pointer",
            padding: 0,
          }}
        >
          {c === value ? <Icon name="check" size={12} style={{ color: "var(--on-pastel)" }} /> : null}
        </button>
      ))}
    </div>
  );
}
