"use client";

import { useState } from "react";
import { Avatar, Button, Checkbox, Dialog, Icon, Input, Radio } from "@/components/ds";
import { getAvatar } from "@/lib/data";
import type { Member } from "@/lib/data/api";
import { refusalOf, setAccessLevel } from "@/lib/data/api";
import type { AccessKind, AccessLevel, AccessTargetRef, AccessView, Group, Role } from "@/lib/data/types";
import { key, type TranslationKey, useTranslation } from "@/lib/i18n";
import { GroupIcon } from "../groups/GroupIcon";
import { foldName } from "../settings/groupsLogic.ts";
import { refusalMessage, roleColour, roleLabel } from "../settings/roleChips";
import { addLevelOptions, levelDescKey, levelLabelKey } from "./accessLogic.ts";
import { targetKey, tk } from "./EntryRow";

type Pick = { ref: AccessTargetRef & { kind: "user" | "group" | "role" }; name: string; guest: boolean };

/**
 * Put people, groups and roles on a resource's access list at one level (frame 3): search, tick, pick
 * the level. The guest ceiling is said where it bites: Manage is greyed when a guest is picked, and a
 * group holding guests warns that its guests get less.
 */
export function AddTargetDialog({
  spaceId,
  kind,
  resourceId,
  resourceName,
  access,
  members,
  groups,
  roles,
  viewerId,
  onClose,
  onAdded,
  onNotify,
}: {
  spaceId: string;
  kind: AccessKind;
  resourceId: string;
  resourceName: string;
  access: AccessView;
  members: Member[];
  groups: Group[];
  roles: Role[];
  viewerId: string | undefined;
  onClose: () => void;
  /** The dialog as it now is, and the names just added. */
  onAdded: (view: AccessView, added: { key: string; name: string }[]) => void;
  onNotify: (toast: { tone: "danger" | "success" | "info"; title: string; description?: string }) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Map<string, Pick>>(() => new Map());
  const [level, setLevel] = useState<Exclude<AccessLevel, "custom" | "none">>("read");
  const [busy, setBusy] = useState(false);
  const needle = foldName(query.trim());

  const listed = new Set(access.entries.filter((e) => !e.inheritedFrom).map((e) => targetKey(e.target)));
  const guestIds = new Set(members.filter((m) => m.role === "guest").map((m) => m.userId));
  const people = members.filter((m) => !m.bot && m.userId !== viewerId && foldName(m.name).includes(needle));
  const shownGroups = groups.filter((g) => foldName(g.name).includes(needle));
  // The administrator role is free to name; a custom role as a target is the paid edition's.
  const shownRoles = roles
    .filter((r) => r.systemKey === "administrator" || (!r.systemKey && access.may.fine))
    .filter((r) => foldName(roleLabel(r, t)).includes(needle));

  const toggle = (id: string, entry: Pick) =>
    setPicked((prev) => {
      const next = new Map(prev);
      if (next.has(id)) next.delete(id);
      else next.set(id, entry);
      return next;
    });

  const chosen = [...picked.values()];
  const options = addLevelOptions(access.may, chosen.map((p) => ({ kind: p.ref.kind, guest: p.guest })));
  const effective = options.find((o) => o.level === level && !o.disabled) ? level : (options.find((o) => !o.disabled)?.level ?? level);
  const guestPerson = chosen.find((p) => p.ref.kind === "user" && p.guest);
  const guestGroups = chosen.filter((p) => p.ref.kind === "group" && groups.find((g) => g.id === p.ref.id)?.memberIds.some((id) => guestIds.has(id)));

  const add = async () => {
    setBusy(true);
    let view = access;
    const added: { key: string; name: string }[] = [];
    try {
      for (const p of chosen) {
        view = await setAccessLevel(spaceId, kind, resourceId, { kind: p.ref.kind, id: p.ref.id }, effective as Exclude<AccessLevel, "custom">);
        added.push({ key: targetKey(p.ref), name: p.name });
      }
      onAdded(view, added);
      onClose();
    } catch (err) {
      // What went through stays; the dialog stays open on what did not.
      if (added.length > 0) onAdded(view, added);
      onNotify({ tone: "danger", title: t("toast.editNotSaved"), description: refusalMessage(refusalOf(err), t, t("space.retry")) });
      setPicked((prev) => {
        const next = new Map(prev);
        for (const a of added) next.delete(a.key);
        return next;
      });
      setBusy(false);
    }
  };

  const section = (title: TranslationKey, body: React.ReactNode, count: number) =>
    count === 0 ? null : (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>{t(title)}</div>
        {body}
      </div>
    );

  const row = (id: string, pick: Pick, lead: React.ReactNode, title: string, sub?: string) => {
    const already = listed.has(id);
    return (
      <label key={id} style={{ display: "flex", alignItems: "center", gap: 10, opacity: already ? 0.6 : 1, cursor: already ? "default" : "pointer" }}>
        <Checkbox aria-label={title} checked={already || picked.has(id)} disabled={already || busy} onChange={() => toggle(id, pick)} />
        {lead}
        <span style={{ minWidth: 0 }}>
          <div style={{ fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--text-strong)" }}>{title}</div>
          <div style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>{already ? t("access.alreadyListed") : sub}</div>
        </span>
      </label>
    );
  };

  return (
    <Dialog
      open
      title={t("access.addTitle", { name: resourceName })}
      subtitle={t("access.addSub")}
      onClose={onClose}
      closeLabel={t("common.close")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" disabled={busy || chosen.length === 0 || options.length === 0} onClick={() => void add()}>
            {chosen.length === 0 ? t("calendar.reminderAdd") : t("access.addConfirm", { count: chosen.length })}
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Input size="sm" icon="search" value={query} autoFocus onChange={(e) => setQuery(e.target.value)} placeholder={t("access.search")} aria-label={t("access.search")} />
        <div style={{ display: "flex", flexDirection: "column", gap: 12, maxHeight: 280, overflow: "auto" }}>
          {section(
            key("groups.title"),
            shownGroups.map((g) =>
              row(`group:${g.id}`, { ref: { kind: "group", id: g.id }, name: g.name, guest: false }, <GroupIcon id={g.id} size={28} />, g.name, t("access.groupSub", { count: g.memberIds.length })),
            ),
            shownGroups.length,
          )}
          {section(
            key("roles.title"),
            shownRoles.map((r) => {
              const name = roleLabel(r, t);
              return row(
                `role:${r.id}`,
                { ref: { kind: "role", id: r.id }, name, guest: false },
                <span aria-hidden style={{ width: 28, height: 28, borderRadius: "var(--radius-md)", background: roleColour(r), color: "var(--on-pastel)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <Icon name="shield-check" size={14} />
                </span>,
                name,
                r.systemKey ? t("roles.colRole") : t("access.customRoleSub"),
              );
            }),
            shownRoles.length,
          )}
          {section(
            key("gsearch.people"),
            people.map((m) => {
              const guest = m.role === "guest";
              return row(`user:${m.userId}`, { ref: { kind: "user", id: m.userId }, name: m.name, guest }, <Avatar name={m.name} src={m.avatarUrl ?? getAvatar(m.name)} size={28} />, m.name, [guest ? t("role.guest") : undefined, m.title].filter(Boolean).join(" · "));
            }),
            people.length,
          )}
        </div>

        {chosen.length > 0 ? (
          <fieldset style={{ border: 0, margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
            <legend style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)", marginBottom: 6 }}>{t("access.levelForSelected", { count: chosen.length })}</legend>
            {options.map((o) => (
              <div key={o.level} style={{ opacity: o.disabled ? 0.6 : 1 }}>
                <Radio
                  name="add-level"
                  checked={effective === o.level}
                  disabled={o.disabled || busy}
                  onChange={() => setLevel(o.level as "read" | "contribute" | "manage")}
                  label={
                    <span>
                      <strong>{t(tk(levelLabelKey(kind, o.level)))}</strong>
                      <span style={{ display: "block", fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
                        {o.reason === "guest" ? t("access.guestCap") : t(tk(levelDescKey(kind, o.level as "read" | "contribute" | "manage")))}
                      </span>
                    </span>
                  }
                />
              </div>
            ))}
          </fieldset>
        ) : null}

        {guestPerson || guestGroups.length > 0 ? (
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "flex-start",
              padding: "10px 12px",
              background: "var(--status-warning-bg)",
              border: "1px solid var(--status-warning-border)",
              borderRadius: "var(--radius-md)",
              fontSize: "var(--text-xs)",
              color: "var(--text-body)",
              lineHeight: "var(--leading-snug)",
            }}
          >
            <Icon name="alert-triangle" size={15} style={{ color: "var(--status-warning-fg)", marginTop: 1, flex: "none" }} />
            <span>
              {guestPerson ? t("access.guestNotice", { name: guestPerson.name }) : null}
              {guestPerson && guestGroups.length > 0 ? " " : null}
              {guestGroups.length > 0 ? t("access.guestGroupNotice", { count: guestGroups.length }) : null}
            </span>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
