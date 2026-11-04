"use client";

import { Avatar, Icon, IconButton, Select, Tag } from "@/components/ds";
import { getAvatar } from "@/lib/data";
import type { Member } from "@/lib/data/api";
import type { AccessEntry, AccessKind, AccessLevel, AccessView, Group, Role } from "@/lib/data/types";
import { key, type TranslationKey, useTranslation } from "@/lib/i18n";
import { GroupIcon } from "../groups/GroupIcon";
import { roleColour } from "../settings/roleChips";
import { canCustomise } from "./customiseLogic.ts";
import { entryEditable, everyoneLine, isYou, entryNote, inheritedLink, levelLabelKey, levelOptions, removable, type OffReason, type Override } from "./accessLogic.ts";

/** A key built by the logic module, as the translator takes it (the keys exist: the tests name them). */
export function tk(name: string): TranslationKey {
  return name as unknown as TranslationKey;
}

const OFF_TITLE: Record<OffReason, TranslationKey> = {
  guest: key("access.guestCap"),
  self: key("access.selfLocked"),
  not_held: key("access.levelNotHeld"),
};

export type RowContext = {
  kind: AccessKind;
  access: AccessView;
  members: Member[];
  groups: Group[];
  roles: Role[];
  viewerId: string | undefined;
  /** The lines added in this session of the dialog, flagged "Ajouté à l'instant". */
  justAdded: Set<string>;
  busy: boolean;
  onLevel: (entry: AccessEntry, level: Exclude<AccessLevel, "custom">) => void;
  onRemove: (entry: AccessEntry) => void;
  /** Opens the fine rules of a line (enterprise); absent, the button is not drawn. */
  onCustomise?: (entry: AccessEntry) => void;
  /** For a file: what each of its own lines replaces, by target (see `withOverrides`). */
  overrides?: Map<string, Override>;
  /** Opens the dialog of the folder an inherited line comes from. */
  onOpenFolder?: (folder: { id: string; name: string }) => void;
  /** Removes a line of the item's own, so the inherited one applies again. */
  onRestore?: (entry: AccessEntry) => void;
};

export function targetKey(target: { kind: string; id?: string }): string {
  return `${target.kind}:${target.id ?? ""}`;
}

/** One line of the access table: who, what level, and what it says about itself. */
export function EntryRow({ entry, ctx }: { entry: AccessEntry; ctx: RowContext }) {
  const { t } = useTranslation();
  const { target } = entry;
  const editable = entryEditable(ctx.access, entry);
  const override = entry.inheritedFrom ? undefined : ctx.overrides?.get(targetKey(entry.target));
  const link = inheritedLink(entry);
  const note = entryNote(entry, ctx.access.entries);
  const options = levelOptions(ctx.access.may, entry, ctx.viewerId);
  const member = target.kind === "user" ? ctx.members.find((m) => m.userId === target.id) : undefined;
  const group = target.kind === "group" ? ctx.groups.find((g) => g.id === target.id) : undefined;
  const role = target.kind === "role" ? ctx.roles.find((r) => r.id === target.id) : undefined;
  const guestsLine = everyoneLine(entry) === "guests";

  let name = target.name ?? t("access.hiddenTarget");
  let sub: string | undefined;
  let lead: React.ReactNode;
  if (target.kind === "everyone") {
    name = guestsLine ? t("access.allGuests") : t("channel.everyoneInSpace");
    sub = guestsLine ? t("access.allGuestsSub") : t("access.everyoneSub");
    lead = <LeadBox><Icon name="users" size={18} /></LeadBox>;
  } else if (target.kind === "role") {
    if (role?.systemKey === "administrator") name = t("role.admin");
    sub = role && !role.systemKey ? t("access.customRoleSub") : t("roles.colRole");
    lead = (
      <LeadBox background={role ? roleColour(role) : "var(--line-strong)"}>
        <Icon name="shield-check" size={18} />
      </LeadBox>
    );
  } else if (target.kind === "group") {
    sub = group ? t("access.groupSub", { count: group.memberIds.length }) : t("groups.colGroup");
    lead = <GroupIcon id={target.id ?? name} size={36} />;
  } else if (target.kind === "audience") {
    name = target.name ? t("access.audienceName", { name: target.name }) : t("access.hiddenTarget");
    sub = t("access.audienceSub");
    lead = <LeadBox><Icon name="message-square" size={18} /></LeadBox>;
  } else {
    sub = isYou(entry, ctx.viewerId) ? t("access.you") : member?.title;
    lead = <Avatar name={name} src={member?.avatarUrl ?? getAvatar(name)} size={36} />;
  }

  let noteText: string | undefined;
  let noteTag: React.ReactNode;
  if (note?.type === "atLeast") noteText = t("access.atLeast", { level: t(tk(levelLabelKey(ctx.kind, note.level))) });
  else if (note?.type === "deny") {
    noteTag = <Tag tone="danger">{t("access.denyTag")}</Tag>;
    noteText = t("access.denyNote");
  } else if (note?.type === "custom") {
    const level = t(tk(levelLabelKey(ctx.kind, note.nearest)));
    noteTag = (
      <Tag>
        {note.mode === "except"
          ? t("access.customExcept", { level, count: note.count })
          : note.mode === "plus"
            ? t("access.customPlus", { level, count: note.count })
            : t("access.customChanges", { level, count: note.count })}
      </Tag>
    );
  } else if (note?.type === "clamped") noteText = t("access.clamped");
  else if (note?.type === "inherited") noteText = note.folder && !link ? t("access.inheritedFrom", { folder: note.folder }) : note.folder ? undefined : t("access.inheritedHidden");
  if (override) {
    const level = t(tk(levelLabelKey(ctx.kind, override.level)));
    noteText = override.folder ? t("access.overrides", { level, folder: override.folder }) : t("access.overridesHidden", { level });
  }

  const selectable = editable && !ctx.busy;
  const canRemove = editable && removable(entry, ctx.viewerId);
  const fresh = ctx.justAdded.has(targetKey(target));

  return (
    <div
      role="row"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 12px",
        borderTop: "1px solid var(--border-subtle)",
        background: fresh ? "var(--status-info-bg)" : undefined,
        opacity: entry.inheritedFrom ? 0.75 : 1,
      }}
    >
      {lead}
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{ fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--text-strong)" }}>{name}</span>
          {entry.guest && target.kind !== "everyone" ? <Tag tone="warning">{t("role.guest")}</Tag> : null}
          {fresh ? <Tag tone="info">{t("access.justAdded")}</Tag> : null}
          {override ? <Tag tone="info">{t("access.modifiedHere")}</Tag> : null}
          {noteTag}
        </div>
        <div style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
          {[sub, noteText].filter(Boolean).join(" · ")}
          {link ? (
            <>
              {sub || noteText ? " · " : ""}
              {t("access.inheritedFromLabel")}{" "}
              <button type="button" onClick={() => ctx.onOpenFolder?.(link)} style={{ ...linkButton, display: "inline-flex", alignItems: "center", gap: 4, verticalAlign: "bottom" }}>
                <Icon name="folder" size={12} />
                {link.name}
              </button>
            </>
          ) : null}
          {override && editable && entry.id ? (
            <>
              {" · "}
              <button type="button" disabled={ctx.busy} onClick={() => ctx.onRestore?.(entry)} style={linkButton}>
                {t("access.restore")}
              </button>
            </>
          ) : null}
        </div>
      </div>
      {ctx.onCustomise && ctx.access.may.fine && editable && canCustomise(ctx.kind, entry, role?.systemKey === "administrator") ? (
        <button
          type="button"
          onClick={() => ctx.onCustomise?.(entry)}
          aria-label={t("customise.openFor", { name })}
          style={{ background: "none", border: 0, cursor: "pointer", color: "var(--text-body)", font: "inherit", fontSize: "var(--text-xs)", fontWeight: 600 }}
        >
          <Icon name="settings" size={14} style={{ verticalAlign: "-2px", marginRight: 4 }} />
          {entry.level === "custom" ? t("access.editDetail") : t("dialogs.customize")}
        </button>
      ) : null}
      <span style={{ position: "relative", display: "inline-flex", flex: "none" }}>
        <Select
          size="sm"
          aria-label={t("access.levelFor", { name })}
          value={entry.level}
          disabled={!selectable}
          style={{ minWidth: 140 }}
          onChange={(e) => ctx.onLevel(entry, e.target.value as Exclude<AccessLevel, "custom">)}
        >
          {options.map((o) => (
            <option key={o.level} value={o.level} disabled={o.disabled && o.level !== entry.level} title={o.reason ? t(OFF_TITLE[o.reason]) : undefined}>
              {t(tk(levelLabelKey(ctx.kind, o.level)))}
            </option>
          ))}
        </Select>
        {/* A line the viewer cannot change says so (frame 11); a busy one is only waiting. */}
        {!editable ? <Icon name="lock" size={14} aria-hidden style={{ position: "absolute", right: 28, top: "50%", transform: "translateY(-50%)", color: "var(--text-muted)", pointerEvents: "none" }} /> : null}
      </span>
      <span style={{ width: 28, flex: "none" }}>
        {canRemove ? (
          <IconButton icon="x" size="sm" label={t("calendar.removeAttendee", { name })} disabled={ctx.busy} onClick={() => ctx.onRemove(entry)} />
        ) : null}
      </span>
    </div>
  );
}

const linkButton = { background: "none", border: 0, padding: 0, cursor: "pointer", font: "inherit", fontWeight: 600, color: "var(--text-strong)" } as const;

function LeadBox({ children, background }: { children: React.ReactNode; background?: string }) {
  return (
    <span
      aria-hidden
      style={{
        width: 36,
        height: 36,
        flex: "none",
        borderRadius: "var(--radius-md)",
        background: background ?? "var(--surface-sunken)",
        border: "1px solid var(--border-subtle)",
        color: background ? "var(--on-pastel)" : "var(--text-body)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {children}
    </span>
  );
}
