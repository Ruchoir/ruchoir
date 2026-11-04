"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Dialog, Icon, Tag } from "@/components/ds";
import type { Member } from "@/lib/data/api";
import { getAccess, getSpaceMembers, listGroups, listRoles, refusalOf, removeAccessEntry, setAccessLevel } from "@/lib/data/api";
import type { AccessEntry, AccessKind, AccessLevel, AccessView, Group, Role } from "@/lib/data/types";
import { key, type TranslationKey, useTranslation } from "@/lib/i18n";
import { shouldToastRefusal } from "../app/previewLogic.ts";
import { refusalMessage, roleLabel } from "../settings/roleChips";
import { type ChainLevel } from "./whyLogic.ts";
import { askWho, delegationIntro, fullPath, canEdit, everyoneLine, freeManage, groupEntries, levelDescKey, levelLabelKey, privateNote, readOnlyReason, withOverrides } from "./accessLogic.ts";
import { AddTargetDialog } from "./AddTargetDialog";
import { CustomiseDialog } from "./CustomiseDialog";
import { WhyDialog } from "./WhyDialog";
import { EntryRow, targetKey, tk } from "./EntryRow";

type Notify = (toast: { tone: "danger" | "success" | "info"; title: string; description?: string }) => void;

type PanelProps = {
  spaceId: string;
  /** What is shared: a channel, a file or folder (`file`), or a space calendar. */
  kind: AccessKind;
  resourceId: string;
  /** Its name as a person knows it (a channel without the `#`). */
  resourceName: string;
  /** A folder rather than a file (the words differ; the rules are the same). */
  isFolder?: boolean;
  /** `private` or `public`, as the channel itself says it (channels only). */
  isPrivate?: boolean;
  archived: boolean;
  viewerId: string | undefined;
  pricingUrl?: string;
  /** Make the channel public or private (the caller's own save); channels only. */
  onTypeChange?: (type: "public" | "private") => void | Promise<unknown>;
  /** Called after any change, so the rest of the app can refresh what depends on access. */
  onChanged?: () => void;
  onNotify: Notify;
  /** Opens "Pourquoi ?" (the entry point; absent, the block is not drawn). */
  onExplain?: () => void;
  /** Opens the fine rules of a line (enterprise; absent, the button is not drawn). */
  onCustomise?: (entry: AccessEntry) => void;
  /** Told each time the view loads, for whoever draws the title around the panel. */
  onLoaded?: (view: AccessView) => void;
  /** Told the folders above a file or folder as one path ("Compta / 2026"), once known. */
  onPath?: (path: string | undefined) => void;
  /** Drawn above the "who can check" block: a file's public link (frame 7). */
  extra?: React.ReactNode;
};

/** The name a line goes by in a title: the person's, the group's, the role's, or what the line itself says. */
function entryDisplayName(entry: AccessEntry, members: Member[], groups: Group[], roles: Role[], t: ReturnType<typeof useTranslation>["t"]): string {
  const { target } = entry;
  if (target.kind === "everyone") return everyoneLine(entry) === "guests" ? t("access.allGuests") : t("channel.everyoneInSpace");
  if (target.kind === "user") return members.find((m) => m.userId === target.id)?.name ?? target.name ?? t("access.hiddenTarget");
  if (target.kind === "group") return groups.find((g) => g.id === target.id)?.name ?? target.name ?? t("access.hiddenTarget");
  if (target.kind === "role") {
    const role = roles.find((r) => r.id === target.id);
    return role ? roleLabel(role, t) : (target.name ?? t("access.hiddenTarget"));
  }
  return target.name ?? t("access.hiddenTarget");
}

/** The line under the title: what this dialog is about, for the kind of thing it shares. */
export function accessSubtitle(kind: AccessKind, isFolder: boolean, view: AccessView | null, fallbackPrivate: boolean, viewerId?: string, path?: string): { key: TranslationKey; parent?: string } {
  // A manager of a free space reads the dialog without changing it (frame 11).
  if (view && freeManage(view, kind, isFolder)) return { key: key("access.freeManage.subtitle") };
  // A local manager of a licensed space reads what their level lets them do (frame 10).
  const delegation = view ? delegationIntro(view, viewerId, kind, isFolder) : undefined;
  if (delegation) return { key: tk(delegation) };
  if (kind === "calendar") return { key: key("access.subtitleCalendar") };
  if (kind === "file") {
    const parent = view?.resource.parent;
    const name = path ?? (parent && !parent.hidden ? parent.name : undefined);
    if (name) return { key: isFolder ? key("access.subtitleFolderIn") : key("access.subtitleFileIn"), parent: name };
    return { key: isFolder ? key("access.subtitleFolder") : key("access.subtitleFile") };
  }
  if (view?.may.fine) return { key: key("access.subtitleEnterprise") };
  return { key: (view?.private ?? fallbackPrivate) ? key("access.subtitlePrivate") : key("access.subtitle") };
}

/**
 * Who has access to a channel, a file, a folder or a calendar, and at what level (frames 1, 2, 4, 6,
 * 7 and 8). The lines say who may read, take part or manage, a level each, and every level includes
 * the one before it. What the caller may do comes from the API's `may` block: the panel offers that
 * and says why the rest is off, it never decides. For files, lines inherited from a folder above are
 * greyed with a link to that folder's own dialog, and a line of the item's own replaces the
 * inherited one for its target until the inheritance is restored.
 */
export function AccessPanel({
  spaceId,
  kind,
  resourceId,
  resourceName,
  isFolder = false,
  isPrivate = false,
  archived,
  viewerId,
  pricingUrl,
  onTypeChange,
  onChanged,
  onNotify,
  onExplain,
  onCustomise,
  onLoaded,
  onPath,
  extra,
}: PanelProps) {
  // Both dialogs belong to the panel; a caller may still take them over with its own handlers.
  const { t } = useTranslation();
  const [access, setAccess] = useState<AccessView | null>(null);
  /** What the parent folder lists: what a file inherits, to tell which of its lines are overrides. */
  const [parentView, setParentView] = useState<AccessView | undefined>(undefined);
  const [members, setMembers] = useState<Member[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<{ key: string; name: string }[]>([]);
  /** The folder whose own dialog is open above this one (a click on "Hérité de ..."). */
  const [folder, setFolder] = useState<{ id: string; name: string } | null>(null);
  /** Bumped when that dialog closes: what this item inherits may have changed. */
  const [stamp, setStamp] = useState(0);
  const [customising, setCustomising] = useState<AccessEntry | null>(null);
  const [explaining, setExplaining] = useState(false);

  const loaded = useRef(onLoaded);
  useEffect(() => {
    loaded.current = onLoaded;
  });

  const load = useCallback(async () => {
    try {
      const view = await getAccess(spaceId, kind, resourceId);
      setAccess(view);
      loaded.current?.(view);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [spaceId, kind, resourceId]);

  useEffect(() => {
    let active = true;
    getAccess(spaceId, kind, resourceId)
      .then((view) => {
        if (!active) return;
        setAccess(view);
        loaded.current?.(view);
        setFailed(false);
      })
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, [spaceId, kind, resourceId, stamp]);

  // The whole path above a file or folder: each parent's own view names the one above it.
  const pathRef = useRef(onPath);
  useEffect(() => {
    pathRef.current = onPath;
  });
  const [chain, setChain] = useState<ChainLevel[]>([]);
  const firstParent = kind === "file" && access?.resource.parent && !access.resource.parent.hidden ? access.resource.parent : undefined;
  useEffect(() => {
    if (!firstParent) {
      pathRef.current?.(undefined);
      return;
    }
    let active = true;
    void (async () => {
      const names: string[] = [firstParent.name ?? ""];
      const levels: ChainLevel[] = [{ id: firstParent.id, name: firstParent.name ?? "", item: false }];
      let next: { id?: string; name?: string; hidden: boolean } | undefined = firstParent;
      for (let depth = 0; depth < 8 && next?.id; depth++) {
        const view: AccessView | undefined = await getAccess(spaceId, "file", next.id).catch(() => undefined);
        const up: { id?: string; name?: string; hidden: boolean } | undefined = view?.resource.parent;
        if (!up || up.hidden) break;
        names.unshift(up.name ?? "");
        levels.unshift({ id: up.id, name: up.name ?? "", item: false });
        next = up;
      }
      if (active) {
        pathRef.current?.(fullPath(names.filter(Boolean)));
        setChain([...levels, { id: resourceId, name: resourceName, item: true }]);
      }
    })();
    return () => {
      active = false;
    };
  }, [spaceId, firstParent?.id, firstParent?.name, stamp]); // eslint-disable-line react-hooks/exhaustive-deps

  const parentId = kind === "file" && access?.resource.parent && !access.resource.parent.hidden ? access.resource.parent.id : undefined;
  useEffect(() => {
    if (!parentId) return;
    let active = true;
    getAccess(spaceId, "file", parentId)
      .then((view) => active && setParentView(view))
      .catch(() => active && setParentView(undefined));
    return () => {
      active = false;
    };
  }, [spaceId, parentId, stamp]);

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
      if (view) {
        setAccess(view);
        loaded.current?.(view);
      } else await load();
      onChanged?.();
    } catch (err) {
      if (shouldToastRefusal(refusalOf(err))) onNotify({ tone: "danger", title: t("toast.editNotSaved"), description: refusalMessage(refusalOf(err), t, t("space.retry")) });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const onLevel = (entry: AccessEntry, level: Exclude<AccessLevel, "custom">) =>
    void run(() => setAccessLevel(spaceId, kind, resourceId, { kind: entry.target.kind, id: entry.target.id }, level));
  const onRemove = (entry: AccessEntry) => {
    if (entry.id) void run(() => removeAccessEntry(spaceId, kind, resourceId, entry.id!));
  };

  const editable = access ? canEdit(access) : false;
  const readOnly = access ? readOnlyReason(access, kind) : undefined;
  const free = access ? freeManage(access, kind, isFolder) : undefined;
  const delegated = access ? delegationIntro(access, viewerId, kind, isFolder) : undefined;
  const asked = askWho(members);
  const who = asked.length === 0 ? t("access.freeManage.noNames") : asked.length === 1 ? asked[0] : `${asked.slice(0, -1).join(", ")} ${t("common.or")} ${asked[asked.length - 1]}`;
  const note = access ? privateNote(access.private, added.filter((a) => access.entries.some((e) => targetKey(e.target) === a.key)).map((a) => a.name)) : undefined;
  const justAdded = new Set(added.map((a) => a.key));
  const merged = access ? withOverrides(access.entries, parentView?.entries, access.resource.parent?.name) : undefined;
  const firstOverride = merged && access ? access.entries.find((e) => !e.inheritedFrom && merged.overrides.has(targetKey(e.target))) : undefined;
  const channelName = `#${resourceName}`;

  const typeCard = (type: "public" | "private") => {
    const active = (type === "private") === (access?.private ?? isPrivate);
    return (
      <button
        key={type}
        type="button"
        role="radio"
        aria-checked={active}
        disabled={!editable || busy}
        onClick={() => !active && void run(async () => { await onTypeChange?.(type); })}
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

  const levels = ["read", "contribute", "manage"] as const;
  const box = { margin: 0, padding: "10px 12px", borderRadius: "var(--radius-md)", fontSize: "var(--text-xs)", color: "var(--text-body)", lineHeight: 1.5 } as const;

  return (
    <>
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

        {access && merged ? (
          <>
            {free ? (
              <p role="status" style={{ ...box, display: "flex", gap: 8, alignItems: "flex-start", background: "var(--status-warning-bg)", border: "1px solid var(--status-warning-border)" }}>
                <Icon name="lock" size={15} style={{ flex: "none", marginTop: 1 }} />
                <span>
                  <strong>{t(tk(free.lead))}</strong> {t(tk(free.detail), { name: kind === "channel" ? channelName : resourceName, who })}
                </span>
              </p>
            ) : readOnly ? (
              <p role="status" style={{ ...box, background: "var(--surface-sunken)", border: "1px solid var(--border-subtle)" }}>
                {t(tk(readOnly))}
              </p>
            ) : null}

            {delegated ? (
              <p role="status" style={{ ...box, display: "flex", gap: 8, alignItems: "flex-start", background: "var(--status-info-bg)", border: "1px solid var(--status-info-border)" }}>
                <Icon name="user-check" size={15} style={{ flex: "none", marginTop: 1 }} />
                <span>
                  <strong>{t("access.delegationHead", { name: kind === "channel" ? channelName : resourceName })}</strong> {t("access.delegationBody")}
                </span>
              </p>
            ) : null}

            {kind === "channel" && onTypeChange ? (
              <div role="radiogroup" aria-label={t("access.typeLabel")} style={{ display: "flex", gap: 12 }}>
                {typeCard("public")}
                {typeCard("private")}
              </div>
            ) : null}

            <div role="table" aria-label={t("access.colWho")} style={{ border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-lg)", overflow: "hidden" }}>
              <div style={{ display: "flex", padding: "8px 12px", background: "var(--surface-sunken)", fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
                <span style={{ flex: 1 }}>{t("access.colWho")}</span>
                <span style={{ width: 168, flex: "none" }}>{t("access.colLevel")}</span>
              </div>
              {groupEntries(merged.entries).map((entry) => (
                <EntryRow
                  key={entry.id ?? `${targetKey(entry.target)}:${entry.inheritedFrom?.id ?? ""}`}
                  entry={entry}
                  ctx={{
                    kind,
                    access,
                    members,
                    groups,
                    roles,
                    viewerId,
                    justAdded,
                    busy,
                    onLevel,
                    onRemove,
                    onCustomise: onCustomise ?? setCustomising,
                    overrides: merged.overrides,
                    onOpenFolder: setFolder,
                    onRestore: onRemove,
                  }}
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
                {delegated ? (
                  t("access.delegationFoot")
                ) : (
                  levels.map((level, i) => (
                  <span key={level}>
                    <strong style={{ color: "var(--text-body)" }}>{t(tk(levelLabelKey(kind, level)))}</strong>
                    {" "}
                    {t(tk(levelDescKey(kind, level)))}
                    {i < levels.length - 1 ? " " : ""}
                  </span>
                  ))
                )}
              </span>
            </p>

            {firstOverride ? (
              <p role="status" style={{ ...box, background: "var(--status-info-bg)", border: "1px solid var(--status-info-border)" }}>
                <strong>{t("access.closestWins")}</strong>{" "}
                {t("access.closestWinsBody", {
                  name: firstOverride.target.name ?? t("access.hiddenTarget"),
                  level: t(tk(levelLabelKey(kind, firstOverride.level))),
                  parentLevel: t(tk(levelLabelKey(kind, merged.overrides.get(targetKey(firstOverride.target))!.level))),
                })}
              </p>
            ) : null}

            {note ? (
              <p role="status" style={{ ...box, background: "var(--status-info-bg)", border: "1px solid var(--status-info-border)" }}>
                {t("access.privateNote", { count: note.names.length, names: note.names.join(", "), channel: channelName })}
              </p>
            ) : null}

            {extra}

            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", border: "1px dashed var(--border-strong)", borderRadius: "var(--radius-lg)", fontSize: "var(--text-xs)", color: "var(--text-body)" }}>
              <Icon name="user-check" size={16} style={{ flex: "none" }} />
              <span style={{ flex: 1 }}>
                <strong>{t("access.verifyTitle")}</strong> {t("access.verifyBody")}
              </span>
              <Button onClick={onExplain ?? (() => setExplaining(true))}>{t("access.verify")}</Button>
            </div>

            {!access.may.fine && pricingUrl ? (
              <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", border: "1px dashed var(--border-strong)", borderRadius: "var(--radius-lg)", fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
                <Icon name="sparkles" size={16} style={{ flex: "none" }} />
                <span style={{ flex: 1 }}>{free ? t(tk(free.cta)) : t("access.teaser")}</span>
                <a href={pricingUrl} target="_blank" rel="noreferrer" style={{ color: "var(--text-link, var(--text-strong))", fontWeight: 600, whiteSpace: "nowrap" }}>
                  {free ? t("access.learnMore") : t("roles.seePricing")} <Icon name="external-link" size={12} />
                </a>
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      {adding && access ? (
        <AddTargetDialog
          spaceId={spaceId}
          kind={kind}
          resourceId={resourceId}
          resourceName={kind === "channel" ? channelName : resourceName}
          access={access}
          members={members}
          groups={groups}
          roles={roles}
          viewerId={viewerId}
          onClose={() => setAdding(false)}
          onAdded={(view, names) => {
            setAccess(view);
            loaded.current?.(view);
            setAdded((prev) => [...prev, ...names]);
            onChanged?.();
          }}
          onNotify={onNotify}
        />
      ) : null}

      {customising && access ? (
        <CustomiseDialog
          spaceId={spaceId}
          kind={kind}
          resourceId={resourceId}
          entry={customising}
          entryName={entryDisplayName(customising, members, groups, roles, t)}
          where={kind === "channel" ? channelName : resourceName}
          access={access}
          pricingUrl={pricingUrl}
          onClose={() => setCustomising(null)}
          onSaved={(view) => {
            setAccess(view);
            loaded.current?.(view);
            onChanged?.();
          }}
          onNotify={onNotify}
        />
      ) : null}

      {explaining ? (
        <WhyDialog spaceId={spaceId} kind={kind} resourceId={resourceId} resourceName={kind === "channel" ? channelName : resourceName} members={members} roles={roles} isFolder={isFolder} chain={firstParent ? chain : [{ id: resourceId, name: resourceName, item: true }]} viewerId={viewerId} onClose={() => setExplaining(false)} />
      ) : null}

      {folder ? (
        <AccessDialog
          spaceId={spaceId}
          kind="file"
          isFolder
          resourceId={folder.id}
          resourceName={folder.name}
          archived={false}
          viewerId={viewerId}
          pricingUrl={pricingUrl}
          onChanged={onChanged}
          onNotify={onNotify}
          onClose={() => {
            setFolder(null);
            setStamp((n) => n + 1);
            onChanged?.();
          }}
        />
      ) : null}
    </>
  );
}

/** The panel in a dialog of its own: the channel's, a calendar's, or a folder opened from a line. */
export function AccessDialog({ onClose, ...panel }: PanelProps & { onClose: () => void }) {
  const { t } = useTranslation();
  const [view, setView] = useState<AccessView | null>(null);
  const [path, setPath] = useState<string | undefined>(undefined);
  const { onLoaded } = panel;
  const sub = accessSubtitle(panel.kind, panel.isFolder ?? false, view, panel.isPrivate ?? false, panel.viewerId, path);
  const title =
    panel.kind === "channel"
      ? t("access.title", { name: `#${panel.resourceName}` })
      : panel.kind === "calendar"
        ? t("access.shareCalendarTitle", { name: panel.resourceName })
        : panel.isFolder
          ? t("access.shareFolderTitle", { name: panel.resourceName })
          : t("files.shareTitle", { name: panel.resourceName });
  return (
    <Dialog
      open
      size="lg"
      title={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
          {title}
          {view?.may.fine ? (
            <Tag tone="info" icon="sparkles">
              {t("guests.rightsEnterprise")}
            </Tag>
          ) : null}
        </span>
      }
      subtitle={t(sub.key, { parent: sub.parent ?? "" })}
      onClose={onClose}
      closeLabel={t("common.close")}
      footer={
        <Button variant="primary" onClick={onClose}>
          {t("onboarding.finish")}
        </Button>
      }
    >
      <AccessPanel
        {...panel}
        onPath={setPath}
        onLoaded={(v) => {
          setView(v);
          onLoaded?.(v);
        }}
      />
    </Dialog>
  );
}
