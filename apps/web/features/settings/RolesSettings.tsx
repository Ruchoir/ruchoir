"use client";

import { type CSSProperties, useState } from "react";
import { Button, Card, Dialog, Field, Icon, Input, Radio, Select, Tag } from "@/components/ds";
import type { Member } from "@/lib/data/api";
import { createRole, orderRoles, refusalOf } from "@/lib/data/api";
import type { Group, Role, SpaceEdition } from "@/lib/data/types";
import { useTranslation } from "@/lib/i18n";
import type { Toast } from "../app/types";
import { useDragReorder } from "../app/useDragReorder";
import { refusalMessage, RoleDot, roleLabel } from "./roleChips";
import { ROLE_NAME_MAX } from "@ruchoir/client/permissionsLogic";
import { CharCount } from "./CharCount";
import { ColourPicker, RoleEditor } from "./RoleEditor";
import { FAMILY_TEXT, PERMISSION_TEXT } from "./permissionText";
import { viewAsState } from "../app/previewLogic.ts";
import { startViewAs } from "./viewAs";
import { FAMILIES, holdsEverything, orderAllowed, type RoleRowState, roleRowState } from "./rolesLogic";

const st: Record<string, CSSProperties> = {
  h: { fontSize: "clamp(28px, 3.4vw, 40px)", fontWeight: 700, letterSpacing: "var(--tracking-display)", lineHeight: 1.05, color: "var(--text-strong)", marginBottom: 10 },
  sub: { fontSize: "var(--text-md)", color: "var(--text-body)", marginBottom: 20 },
  tools: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 14 },
  muted: { fontSize: "var(--text-xs)", color: "var(--text-muted)" },
  row: { display: "flex", alignItems: "center", gap: 10, padding: "11px 14px", background: "var(--surface-raised)" },
  head: { display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", fontFamily: "var(--label-font)", fontSize: "var(--text-2xs)", color: "var(--text-muted)" },
  grip: { width: 16, flex: "none", display: "flex", color: "var(--text-muted)" },
  name: { flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 8, fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--text-strong)" },
  count: { width: 90, flex: "none", fontSize: "var(--text-xs)", color: "var(--text-body)" },
  sum: { width: 90, flex: "none", fontSize: "var(--text-xs)", color: "var(--text-body)" },
  right: { width: 230, flex: "none", display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 5, fontSize: "var(--text-2xs)", color: "var(--text-muted)" },
  sep: { padding: "8px 14px", fontFamily: "var(--label-font)", fontSize: "var(--text-2xs)", color: "var(--text-muted)", background: "var(--surface-sunken)", borderTop: "1px solid var(--border-subtle)" },
  note: { fontSize: "var(--text-2xs)", fontWeight: 400, color: "var(--text-muted)" },
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

export type RolesSettingsProps = {
  spaceId: string;
  spaceName: string;
  edition: SpaceEdition;
  /** The space's roles, strongest first, base roles last. */
  roles: Role[];
  members: Member[];
  /** The space's groups, for the people a role reaches through them. */
  groups: Group[];
  /** Opens a group in the Groupes tab; absent when the viewer does not manage groups. */
  onOpenGroup?: (groupId: string) => void;
  me?: Member;
  /** What the viewer holds in the space. */
  myRights: string[];
  pricingUrl?: string;
  onChanged: () => Promise<void>;
  onSetMemberRoles: (userId: string, roleIds: string[]) => Promise<boolean>;
  onNotify: (toast: Toast) => void;
  /** A role to open straight away (the guests' role, from "Droits des invités"). */
  initialRoleId?: string;
};

/** The Roles tab: the fixed roles read in a community space, the ranked list in a licensed one. */
export function RolesSettings(props: RolesSettingsProps) {
  const { roles, edition } = props;
  const [editing, setEditing] = useState<string | null>(props.initialRoleId ?? null);
  const role = editing ? roles.find((r) => r.id === editing) : undefined;
  if (role) {
    return (
      <RoleEditor
        // A role read again after a save starts its draft from what was saved.
        key={`${role.id}:${role.permissions.join(",")}:${role.name}:${role.colour ?? ""}`}
        spaceId={props.spaceId}
        role={role}
        roles={roles}
        members={props.members}
        groups={props.groups}
        onOpenGroup={props.onOpenGroup}
        myRights={props.myRights}
        frozen={edition === "frozen"}
        onBack={() => setEditing(null)}
        onChanged={props.onChanged}
        onSetMemberRoles={props.onSetMemberRoles}
        onNotify={props.onNotify}
      />
    );
  }
  return edition === "community" ? <CommunityRoles {...props} /> : <RankedRoles {...props} onOpen={setEditing} />;
}

/** The three fixed roles of a community space, read only, and the one discreet line about more. */
function CommunityRoles({ roles, spaceName, pricingUrl, myRights }: RolesSettingsProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<string | null>(null);
  const shown: { role: Role; tag: string; lead: string; warning?: boolean }[] = [];
  for (const role of roles) {
    if (role.systemKey === "administrator") shown.push({ role, tag: t("message.reactors", { count: role.holders }), lead: t("roles.adminLead") });
    if (role.systemKey === "members") shown.push({ role, tag: t("roles.everyMember"), lead: t("roles.membersLead") });
    if (role.systemKey === "guests") shown.push({ role, tag: t("role.guest"), lead: t("roles.guestsLead"), warning: true });
  }
  return (
    <>
      <h2 style={st.h}>{t("roles.title")}</h2>
      <p style={st.sub}>{t("roles.communitySub", { space: spaceName })}</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {shown.map(({ role, tag, lead, warning }) => {
          const isOpen = open === role.id;
          return (
            <Card key={role.id} padded>
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? null : role.id)}
                style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", border: 0, background: "transparent", padding: 0, cursor: "pointer", textAlign: "left", fontFamily: "var(--font-sans)" }}
              >
                <RoleDot role={role} size={10} />
                <b style={{ fontSize: "var(--text-sm)", color: "var(--text-strong)" }}>{roleLabel(role, t)}</b>
                <Tag tone={warning ? "warning" : "neutral"}>{tag}</Tag>
                <span style={{ flex: 1 }} />
                <span style={st.muted}>{isOpen ? t("roles.hideDetail") : t("import.recentOpen")}</span>
                <Icon name={isOpen ? "chevron-down" : "chevron-right"} size={14} style={{ color: "var(--text-muted)" }} />
              </button>
              <p style={{ fontSize: "var(--text-xs)", color: "var(--text-body)", margin: "8px 0 0", lineHeight: "var(--leading-snug)" }}>{lead}</p>
              {isOpen ? <PermissionList permissions={role.permissions} /> : null}
            </Card>
          );
        })}
      </div>
      {viewAsState({ manageable: true }, { edition: "community", canManageRoles: myRights.includes("roles.manage") }) === "locked" ? (
        <p style={{ ...st.muted, display: "flex", alignItems: "center", gap: 6, margin: "12px 0 0" }}>
          <Icon name="lock" size={13} />
          {t("preview.locked")}
        </p>
      ) : null}
      <div style={st.upsell}>
        <Icon name="star" size={15} style={{ color: "var(--text-muted)" }} />
        <span style={{ flex: 1, minWidth: 200 }}>
          <b>{t("roles.upsellStrong")}</b> {t("roles.upsellRest")}
        </span>
        {pricingUrl ? (
          <a className="wc-btn wc-btn--link wc-btn--sm" href={pricingUrl} target="_blank" rel="noreferrer">
            {t("roles.seePricing")}
            <Icon name="external-link" size={13} />
          </a>
        ) : null}
      </div>
    </>
  );
}

/** What a role grants, family by family. */
function PermissionList({ permissions }: { permissions: string[] }) {
  const { t } = useTranslation();
  return (
    <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
      {FAMILIES.map((family) => {
        const held = family.permissions.filter((p) => permissions.includes(p));
        if (held.length === 0) return null;
        return (
          <div key={family.key}>
            <div style={{ fontFamily: "var(--label-font)", fontSize: "var(--text-2xs)", color: "var(--text-muted)", marginBottom: 4 }}>{t(FAMILY_TEXT[family.key])}</div>
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 3 }}>
              {held.map((p) => (
                <li key={p} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "var(--text-xs)", color: "var(--text-body)" }}>
                  <Icon name="check" size={13} style={{ color: "var(--success)" }} />
                  {t(PERMISSION_TEXT[p].title)}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

/** The roles of a licensed space, strongest first, with the ones below the viewer dragged to reorder. */
function RankedRoles({ spaceId, roles, me, myRights, edition, onChanged, onNotify, onOpen }: RolesSettingsProps & { onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const frozen = edition === "frozen";
  const canManage = myRights.includes("roles.manage") && !frozen;
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const ranked = roles.filter((r) => r.systemKey !== "members" && r.systemKey !== "guests");
  const base = roles.filter((r) => r.systemKey === "members" || r.systemKey === "guests");
  // What the viewer may move sits at the bottom of the ranked list, below their own highest role.
  const fixedTop = canManage ? ranked.filter((r) => !r.manageable) : ranked;
  const movable = canManage ? ranked.filter((r) => r.manageable) : [];
  const myTopRoleId = me?.roleIds?.[0];

  const move = async (from: number, to: number) => {
    const next = [...movable];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    const wanted = [...fixedTop, ...next].map((r) => r.id);
    if (!orderAllowed(ranked, wanted)) return;
    setBusy(true);
    try {
      await orderRoles(spaceId, wanted);
      await onChanged();
    } catch (err) {
      onNotify({ tone: "danger", title: t("roles.orderFailed"), description: refusalMessage(refusalOf(err), t, t("space.retry")) });
    } finally {
      setBusy(false);
    }
  };
  const drag = useDragReorder({ count: movable.length, onMove: (from, to) => void move(from, to) });

  const right = (state: RoleRowState) => {
    if (state === "above")
      return (
        <>
          <Icon name="lock" size={13} />
          {t("roles.aboveShort")}
        </>
      );
    if (state === "mine")
      return (
        <>
          <Icon name="lock" size={13} />
          {t("roles.mineShort")}
        </>
      );
    if (state === "frozen")
      return (
        <>
          <Icon name="clock" size={13} />
          {t("roles.frozenShort")}
        </>
      );
    if (state === "edit") return <Icon name="chevron-right" size={16} />;
    return null;
  };

  /** "Voir en tant que" on a row the viewer manages; it does not open the editor. */
  const viewAs = (role: Role) =>
    viewAsState(role, { edition, canManageRoles: myRights.includes("roles.manage") }) === "button" ? (
      <Button
        size="sm"
        variant="secondary"
        iconLeft="eye"
        aria-label={t("preview.viewAsFor", { role: roleLabel(role, t) })}
        onClick={(e) => {
          e.stopPropagation();
          void startViewAs(spaceId, role, onNotify, t);
        }}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {t("preview.viewAs")}
      </Button>
    ) : null;

  const rowOf = (role: Role, index: number, dragIndex?: number) => {
    const state = roleRowState(role, { myTopRoleId, frozen });
    const opens = state === "edit" && myRights.includes("roles.manage");
    const isBase = role.systemKey === "members" || role.systemKey === "guests";
    return (
      <div
        key={role.id}
        ref={dragIndex !== undefined ? drag.itemRef(dragIndex) : undefined}
        role={opens ? "button" : undefined}
        tabIndex={opens ? 0 : undefined}
        onClick={opens ? () => onOpen(role.id) : undefined}
        onKeyDown={opens ? (e) => (e.key === "Enter" || e.key === " ") && onOpen(role.id) : undefined}
        style={{
          ...st.row,
          borderTop: index ? "1px solid var(--border-subtle)" : "none",
          cursor: opens ? "pointer" : "default",
          ...(dragIndex !== undefined ? drag.itemStyle(dragIndex) : {}),
        }}
      >
        <span
          style={{ ...st.grip, cursor: dragIndex !== undefined ? "grab" : "default", touchAction: "none" }}
          onPointerDown={dragIndex !== undefined && !busy ? drag.onPointerDown(dragIndex) : undefined}
          aria-hidden
        >
          {dragIndex !== undefined ? <Icon name="grip-vertical" size={16} /> : null}
        </span>
        <RoleDot role={role} size={10} />
        <span style={isBase ? { ...st.name, flexDirection: "column", alignItems: "flex-start", gap: 2 } : st.name}>
          <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, maxWidth: "100%" }}>
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{roleLabel(role, t)}</span>
            {role.systemKey === "administrator" ? <Tag>{t("roles.system")}</Tag> : null}
          </span>
          {isBase ? <span style={st.note}>{role.systemKey === "members" ? t("roles.membersLead") : t("roles.guestsNote")}</span> : null}
        </span>
        <span style={st.count}>{role.systemKey === "members" ? t("roles.everyMember") : role.holders}</span>
        <span style={st.sum}>{holdsEverything(role) ? t("roles.allRights") : t("roles.rightsCount", { count: role.permissions.length })}</span>
        <span style={st.right}>
          {viewAs(role)}
          {right(state)}
        </span>
      </div>
    );
  };

  return (
    <>
      <h2 style={st.h}>{t("roles.title")}</h2>
      <p style={st.sub}>{t("roles.rankedSub")}</p>
      <div style={st.tools}>
        <span style={st.muted}>{frozen ? t("roles.frozenNote") : canManage ? t("roles.dragHint") : t("roles.readHint")}</span>
        <span style={{ flex: 1 }} />
        {canManage ? (
          <Button size="sm" variant="primary" iconLeft="plus" onClick={() => setCreating(true)}>
            {t("roles.create")}
          </Button>
        ) : null}
      </div>
      <Card>
        <div style={st.head}>
          <span style={st.grip} />
          <span style={{ width: 10 }} />
          <span style={{ ...st.name, fontWeight: 400, fontSize: "var(--text-2xs)", color: "var(--text-muted)" }}>{t("roles.colRole")}</span>
          <span style={{ ...st.count, color: "var(--text-muted)" }}>{t("gsearch.people")}</span>
          <span style={{ ...st.sum, color: "var(--text-muted)" }}>{t("roles.tabRights")}</span>
          <span style={st.right} />
        </div>
        {fixedTop.map((role, i) => rowOf(role, i + 1))}
        {movable.map((role, i) => rowOf(role, fixedTop.length + i + 1, i))}
        <div style={st.sep}>{t("roles.baseSeparator")}</div>
        {base.map((role, i) => rowOf(role, i))}
      </Card>
      {movable.some((r) => viewAsState(r, { edition, canManageRoles: myRights.includes("roles.manage") }) === "button") ? (
        <p style={{ ...st.muted, display: "flex", alignItems: "flex-start", gap: 6, margin: "10px 0 0", lineHeight: 1.5 }}>
          <Icon name="eye" size={13} style={{ marginTop: 2, flex: "none" }} />
          {t("preview.hint")}
        </p>
      ) : null}
      {creating ? (
        <CreateRoleDialog
          spaceId={spaceId}
          copyable={movable.filter((r) => !r.systemKey)}
          onClose={() => setCreating(false)}
          onCreated={async (id) => {
            setCreating(false);
            await onChanged();
            onOpen(id);
          }}
        />
      ) : null}
    </>
  );
}

/** A new role: its name, its colour, and empty or copied from one the viewer manages. */
function CreateRoleDialog({ spaceId, copyable, onClose, onCreated }: { spaceId: string; copyable: Role[]; onClose: () => void; onCreated: (id: string) => Promise<void> }) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [colour, setColour] = useState("mint");
  const [from, setFrom] = useState<"nothing" | "copy">("nothing");
  const [copyOf, setCopyOf] = useState(copyable[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const create = async () => {
    setBusy(true);
    setError("");
    try {
      const role = await createRole(spaceId, { name: name.trim(), colour, copyFrom: from === "copy" && copyOf ? copyOf : undefined });
      await onCreated(role.id);
    } catch (err) {
      setError(refusalMessage(refusalOf(err), t, t("roles.saveFailed")));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={t("roles.create")}
      subtitle={t("roles.createSub")}
      onClose={onClose}
      closeLabel={t("common.close")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" disabled={busy || !name.trim()} onClick={() => void create()}>
            {busy ? t("common.creating") : t("roles.createAndChoose")}
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <Field label={t("files.name")} htmlFor="new-role-name" error={error || undefined}>
          <Input id="new-role-name" value={name} maxLength={ROLE_NAME_MAX} autoFocus onChange={(e) => setName(e.target.value)} placeholder={t("roles.namePlaceholder")} />
          <CharCount value={name} max={ROLE_NAME_MAX} />
        </Field>
        <Field label={t("calendar.colorLabel")}>
          <ColourPicker value={colour} onChange={setColour} />
        </Field>
        <Field label={t("roles.startFrom")}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <Radio name="from" checked={from === "nothing"} onChange={() => setFrom("nothing")} label={t("roles.fromNothing")} description={t("roles.fromNothingDesc")} />
            {copyable.length > 0 ? (
              <>
                <Radio name="from" checked={from === "copy"} onChange={() => setFrom("copy")} label={t("roles.fromCopy")} description={t("roles.fromCopyDesc")} />
                {from === "copy" ? (
                  <div style={{ maxWidth: 260, marginLeft: 28 }}>
                    <Select size="sm" aria-label={t("roles.fromCopy")} value={copyOf} onChange={(e) => setCopyOf(e.target.value)} options={copyable.map((r) => ({ value: r.id, label: r.name }))} />
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        </Field>
      </div>
    </Dialog>
  );
}
