"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Dialog, Icon, Tag } from "@/components/ds";
import type { Member } from "@/lib/data/api";
import { getAccess, getSpaceMembers, listGroups, listRoles, refusalOf, removeAccessEntry, setAccessLevel } from "@/lib/data/api";
import type { AccessEntry, AccessLevel, AccessView, Group, Role } from "@/lib/data/types";
import { key, type TranslationKey, useTranslation } from "@/lib/i18n";
import { refusalMessage } from "../settings/roleChips";
import { canEdit, groupEntries, levelDescKey, levelLabelKey, privateNote, readOnlyReason } from "./accessLogic.ts";
import { AddTargetDialog } from "./AddTargetDialog";
import { EntryRow, targetKey, tk } from "./EntryRow";

type Notify = (toast: { tone: "danger" | "success" | "info"; title: string; description?: string }) => void;

/**
 * Who has access to a channel, and at what level (frames 1, 2 and 4). Public or private stays a choice
 * of its own; the lines below say who may read, take part or manage, a level each, and every level
 * includes the one before it. What the caller may do comes from the API's `may` block: the dialog
 * offers that and says why the rest is off, it never decides.
 */
export function AccessDialog({
  spaceId,
  channelId,
  channelName,
  isPrivate,
  archived,
  viewerId,
  pricingUrl,
  onTypeChange,
  onChanged,
  onClose,
  onNotify,
  onExplain,
  onCustomise,
}: {
  spaceId: string;
  channelId: string;
  channelName: string;
  /** `private` or `public`, as the channel itself says it. */
  isPrivate: boolean;
  archived: boolean;
  viewerId: string | undefined;
  pricingUrl?: string;
  /** Make the channel public or private (the caller's own save). */
  onTypeChange: (type: "public" | "private") => void | Promise<unknown>;
  /** Called after any change, so the rest of the app can refresh what depends on access. */
  onChanged?: () => void;
  onClose: () => void;
  onNotify: Notify;
  /** Opens "Pourquoi ?" (the entry point; absent, the block is not drawn). */
  onExplain?: () => void;
  /** Opens the fine rules of a line (enterprise; absent, the button is not drawn). */
  onCustomise?: (entry: AccessEntry) => void;
}) {
  const { t } = useTranslation();
  const [access, setAccess] = useState<AccessView | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<{ key: string; name: string }[]>([]);

  const load = useCallback(async () => {
    try {
      setAccess(await getAccess(spaceId, "channel", channelId));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [spaceId, channelId]);

  useEffect(() => {
    let active = true;
    getAccess(spaceId, "channel", channelId)
      .then((view) => active && setAccess(view))
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, [spaceId, channelId]);

  // The names the lines show. A failure here leaves the lines unnamed rather than the dialog empty.
  useEffect(() => {
    let active = true;
    void Promise.allSettled([getSpaceMembers(spaceId), listGroups(spaceId), listRoles(spaceId)]).then(([m, g, r]) => {
      if (!active) return;
      if (m.status === "fulfilled") setMembers(m.value);
      if (g.status === "fulfilled") setGroups(g.value);
      if (r.status === "fulfilled") setRoles(r.value);
    });
    return () => {
      active = false;
    };
  }, [spaceId]);

  const run = async (work: () => Promise<AccessView | void>) => {
    setBusy(true);
    try {
      const view = await work();
      if (view) setAccess(view);
      else await load();
      onChanged?.();
    } catch (err) {
      onNotify({ tone: "danger", title: t("toast.editNotSaved"), description: refusalMessage(refusalOf(err), t, t("space.retry")) });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const onLevel = (entry: AccessEntry, level: Exclude<AccessLevel, "custom">) =>
    void run(() => setAccessLevel(spaceId, "channel", channelId, { kind: entry.target.kind, id: entry.target.id }, level));
  const onRemove = (entry: AccessEntry) => {
    if (entry.id) void run(() => removeAccessEntry(spaceId, "channel", channelId, entry.id!));
  };

  const editable = access ? canEdit(access) : false;
  const readOnly = access ? readOnlyReason(access) : undefined;
  const note = access ? privateNote(access.private, added.filter((a) => access.entries.some((e) => targetKey(e.target) === a.key)).map((a) => a.name)) : undefined;
  const justAdded = new Set(added.map((a) => a.key));

  const typeCard = (type: "public" | "private") => {
    const active = (type === "private") === (access?.private ?? isPrivate);
    return (
      <button
        key={type}
        type="button"
        role="radio"
        aria-checked={active}
        disabled={!editable || busy}
        onClick={() => !active && void run(async () => { await onTypeChange(type); })}
        style={{
          flex: 1,
          display: "flex",
          gap: 10,
          alignItems: "flex-start",
          textAlign: "left",
          padding: "12px 14px",
          background: "var(--surface-raised)",
          border: active ? "2px solid var(--text-strong)" : "1px solid var(--border-subtle)",
          borderRadius: "var(--radius-lg)",
          cursor: editable ? "pointer" : "default",
          font: "inherit",
          color: "var(--text-body)",
        }}
      >
        <Icon name={type === "private" ? "lock" : "hash"} size={16} style={{ marginTop: 3, flex: "none" }} />
        <span>
          <strong style={{ display: "block", color: "var(--text-strong)", fontSize: "var(--text-sm)" }}>{type === "private" ? t("access.privateTitle") : t("access.publicTitle")}</strong>
          <span style={{ fontSize: "var(--text-xs)" }}>{type === "private" ? t("access.privateBody") : t("access.publicBody")}</span>
        </span>
      </button>
    );
  };

  const subtitle: TranslationKey = access?.may.fine ? key("access.subtitleEnterprise") : access?.private ? key("access.subtitlePrivate") : key("access.subtitle");
  const levels = ["read", "contribute", "manage"] as const;

  return (
    <>
      <Dialog
        open
        size="lg"
        title={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
            {t("access.title", { name: `#${channelName}` })}
            {access?.may.fine ? (
              <Tag tone="info" icon="sparkles">
                {t("access.enterprise")}
              </Tag>
            ) : null}
          </span>
        }
        subtitle={t(subtitle)}
        onClose={onClose}
        closeLabel={t("common.close")}
        footer={
          <Button variant="primary" onClick={onClose}>
            {t("onboarding.finish")}
          </Button>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {failed ? (
            <p role="alert" style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--status-danger-fg)" }}>
              {t("access.loadFailed")}{" "}
              <Button size="sm" onClick={() => void load()}>
                {t("common.retry")}
              </Button>
            </p>
          ) : null}
          {!access && !failed ? <p style={{ margin: 0, color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>{t("access.loading")}</p> : null}

          {access ? (
            <>
              {readOnly ? (
                <p
                  role="status"
                  style={{ margin: 0, padding: "10px 12px", background: "var(--surface-sunken)", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-md)", fontSize: "var(--text-xs)", color: "var(--text-body)", lineHeight: 1.5 }}
                >
                  {t(tk(readOnly))}
                </p>
              ) : null}

              <div role="radiogroup" aria-label={t("access.typeLabel")} style={{ display: "flex", gap: 12 }}>
                {typeCard("public")}
                {typeCard("private")}
              </div>

              <div role="table" aria-label={t("access.colWho")} style={{ border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-lg)", overflow: "hidden" }}>
                <div style={{ display: "flex", padding: "8px 12px", background: "var(--surface-sunken)", fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
                  <span style={{ flex: 1 }}>{t("access.colWho")}</span>
                  <span style={{ width: 168, flex: "none" }}>{t("access.colLevel")}</span>
                </div>
                {groupEntries(access.entries).map((entry) => (
                  <EntryRow
                    key={entry.id ?? `${targetKey(entry.target)}:${entry.inheritedFrom?.id ?? ""}`}
                    entry={entry}
                    ctx={{ kind: "channel", access, members, groups, roles, viewerId, justAdded, busy, onLevel, onRemove, onCustomise }}
                  />
                ))}
              </div>

              {editable ? (
                <div>
                  <Button iconLeft="user-plus" onClick={() => setAdding(true)} disabled={busy}>
                    {t("access.add")}
                  </Button>
                </div>
              ) : null}

              <p style={{ margin: 0, display: "flex", gap: 8, fontSize: "var(--text-xs)", color: "var(--text-muted)", lineHeight: 1.5 }}>
                <Icon name="info" size={14} style={{ flex: "none", marginTop: 2 }} />
                <span>
                  {levels.map((level, i) => (
                    <span key={level}>
                      <strong style={{ color: "var(--text-body)" }}>{t(tk(levelLabelKey("channel", level)))}</strong>
                      {" "}
                      {t(tk(levelDescKey("channel", level)))}
                      {i < levels.length - 1 ? " " : ""}
                    </span>
                  ))}
                </span>
              </p>

              {note ? (
                <p
                  role="status"
                  style={{ margin: 0, padding: "10px 12px", background: "var(--status-info-bg)", border: "1px solid var(--status-info-border)", borderRadius: "var(--radius-md)", fontSize: "var(--text-xs)", color: "var(--text-body)", lineHeight: 1.5 }}
                >
                  {t("access.privateNote", { count: note.names.length, names: note.names.join(", "), channel: `#${channelName}` })}
                </p>
              ) : null}

              {onExplain ? (
                <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", border: "1px dashed var(--border-strong)", borderRadius: "var(--radius-lg)", fontSize: "var(--text-xs)", color: "var(--text-body)" }}>
                  <Icon name="user-check" size={16} style={{ flex: "none" }} />
                  <span style={{ flex: 1 }}>
                    <strong>{t("access.verifyTitle")}</strong> {t("access.verifyBody")}
                  </span>
                  <Button onClick={onExplain}>{t("mfa.verify")}</Button>
                </div>
              ) : null}

              {!access.may.fine && pricingUrl ? (
                <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", border: "1px dashed var(--border-strong)", borderRadius: "var(--radius-lg)", fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
                  <Icon name="sparkles" size={16} style={{ flex: "none" }} />
                  <span style={{ flex: 1 }}>{t("access.teaser")}</span>
                  <a href={pricingUrl} target="_blank" rel="noreferrer" style={{ color: "var(--text-link, var(--text-strong))", fontWeight: 600, whiteSpace: "nowrap" }}>
                    {t("roles.seePricing")} <Icon name="external-link" size={12} />
                  </a>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </Dialog>

      {adding && access ? (
        <AddTargetDialog
          spaceId={spaceId}
          kind="channel"
          resourceId={channelId}
          resourceName={`#${channelName}`}
          access={access}
          members={members}
          groups={groups}
          roles={roles}
          viewerId={viewerId}
          onClose={() => setAdding(false)}
          onAdded={(view, names) => {
            setAccess(view);
            setAdded((prev) => [...prev, ...names]);
            onChanged?.();
          }}
          onNotify={onNotify}
        />
      ) : null}
    </>
  );
}
