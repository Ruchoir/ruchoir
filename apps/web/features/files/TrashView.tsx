"use client";

import { type CSSProperties, useEffect, useState } from "react";
import { Button, Dialog, EmptyState, FileIcon, Icon, IconButton, Skeleton, SkeletonGroup } from "@/components/ds";
import { emptyTrash, eraseFile, getTrash, restoreFile, type TrashEntry } from "@/lib/data/api";
import { useTranslation } from "@/lib/i18n";
import { formatStamp } from "@/lib/i18n/format";
import type { Toast } from "../app/types";
import { ActionMenu, type MenuEntry } from "./ActionMenu";
import { FileName } from "./FileName";
import type { MenuAt } from "./listTypes";

const styles: Record<string, CSSProperties> = {
  banner: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 14px",
    marginBottom: 14,
    borderRadius: "var(--radius-md)",
    background: "var(--surface-sunken)",
    fontSize: "var(--text-xs)",
    color: "var(--text-body)",
  },
  wrap: { border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-md)", overflow: "hidden", background: "var(--surface-card)" },
  table: { width: "100%", borderCollapse: "collapse", tableLayout: "fixed" },
  th: {
    fontFamily: "var(--font-mono)",
    height: 36,
    textAlign: "left",
    fontSize: "var(--text-2xs)",
    fontWeight: 500,
    color: "var(--text-muted)",
    padding: "0 12px",
    background: "var(--surface-canvas)",
    borderBottom: "1.5px solid var(--border-subtle)",
  },
  td: {
    height: 46,
    padding: "0 12px",
    borderBottom: "1px solid var(--border-subtle)",
    fontSize: "var(--text-xs)",
    color: "var(--text-body)",
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
  },
  row: { display: "flex", alignItems: "center", gap: 12, minHeight: 56, padding: "6px 4px 6px 12px", borderBottom: "1px solid var(--border-subtle)" },
};

/**
 * The space's trash: what was removed, by whom, when and from where, to restore or to erase for
 * good. Erasing asks first, as nothing brings it back; restoring does not.
 */
export function TrashView({
  spaceId,
  compact,
  retentionDays,
  rootLabel,
  stamp,
  onNotify,
  onRestored,
}: {
  spaceId: string;
  compact: boolean;
  /** Days an entry stays before it is erased (0 or unknown: no such notice). */
  retentionDays?: number;
  rootLabel: string;
  /** Bumped from outside (an "Undo" restored something): ask again. */
  stamp: number;
  onNotify: (toast: Toast) => void;
  /** Something came back to the files. */
  onRestored: () => void;
}) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<TrashEntry[] | null>(null);
  const [menu, setMenu] = useState<{ entry: TrashEntry; at: MenuAt } | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "one"; entry: TrashEntry } | { kind: "all" } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    getTrash(spaceId, ctrl.signal)
      .then(setEntries)
      .catch(() => {
        if (ctrl.signal.aborted) return;
        setEntries([]);
        onNotify({ tone: "danger", title: t("files.trashLoadFailed") });
      });
    return () => ctrl.abort();
    // `onNotify` and `t` are not reasons to ask again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId, stamp, reloadKey]);

  const reload = () => setReloadKey((n) => n + 1);
  const where = (e: TrashEntry) => (e.originalFolderId ? (e.originalFolderName ?? rootLabel) : rootLabel);

  const restore = (entry: TrashEntry) => {
    if (!entry.file.id) return;
    restoreFile(entry.file.id)
      .then(({ restoredToRoot }) => {
        onNotify({
          tone: "success",
          title: t("files.restoredOne"),
          description: restoredToRoot ? t("files.restoredToRoot", { name: entry.file.name }) : t("files.restoredInto", { folder: where(entry) }),
        });
        setEntries((prev) => prev?.filter((e) => e.file.id !== entry.file.id) ?? prev);
        onRestored();
      })
      .catch(() => onNotify({ tone: "danger", title: t("files.restoreFailed") }));
  };

  const confirmErase = () => {
    const what = confirm;
    setConfirm(null);
    if (!what) return;
    if (what.kind === "all") {
      emptyTrash(spaceId)
        .then((n) => {
          onNotify({ tone: "success", title: t("files.erasedMany", { count: n }) });
          reload();
        })
        .catch(() => onNotify({ tone: "danger", title: t("files.eraseFailed") }));
      return;
    }
    const id = what.entry.file.id;
    if (!id) return;
    eraseFile(id)
      .then(() => {
        onNotify({ tone: "success", title: t("files.erasedOne"), description: what.entry.file.name });
        setEntries((prev) => prev?.filter((e) => e.file.id !== id) ?? prev);
      })
      .catch(() => onNotify({ tone: "danger", title: t("files.eraseFailed") }));
  };

  const menuEntries = (entry: TrashEntry): MenuEntry[] => [
    { label: t("files.restore"), icon: "undo-2", onSelect: () => restore(entry) },
    { separator: true },
    { label: t("space.deleteConfirm"), icon: "trash-2", danger: true, onSelect: () => setConfirm({ kind: "one", entry }) },
  ];
  const manageable = entries?.filter((e) => e.canManage) ?? [];

  const icon = (e: TrashEntry) =>
    e.file.kind === "folder" ? <Icon name="folder" size={compact ? 22 : 18} style={{ flex: "none", color: "var(--ink)" }} /> : <FileIcon name={e.file.name} size={compact ? 28 : 22} />;
  const more = (e: TrashEntry) =>
    e.canManage ? (
      <IconButton
        icon="more-horizontal"
        label={t("sidebar.actionsFor", { name: e.file.name })}
        aria-haspopup="menu"
        size={compact ? "md" : "sm"}
        style={compact ? { width: 44, height: 44, flex: "none" } : undefined}
        onClick={(ev) => setMenu({ entry: e, at: { anchor: ev.currentTarget } })}
      />
    ) : null;

  return (
    <>
      {/* On a phone the button goes under the notice: side by side, the sentence had a third of the width. */}
      <div style={compact ? { ...styles.banner, flexWrap: "wrap", margin: "0 12px 12px" } : styles.banner}>
        <Icon name="trash-2" size={16} style={{ flex: "none", color: "var(--text-muted)" }} />
        <span style={compact ? { flex: "1 1 calc(100% - 26px)", minWidth: 0 } : { flex: 1, minWidth: 0 }}>
          {retentionDays ? t("files.trashRetention", { count: retentionDays }) : t("files.trashKept")}
        </span>
        {manageable.length > 0 ? (
          <Button
            size="sm"
            variant="danger"
            iconLeft="trash-2"
            onClick={() => setConfirm({ kind: "all" })}
            style={compact ? { marginLeft: 26 } : { flexShrink: 0 }}
          >
            {t("files.emptyTrash")}
          </Button>
        ) : null}
      </div>

      {entries === null ? (
        <SkeletonGroup label={t("files.trashLoading")}>
          {[0.6, 0.4, 0.5].map((w, i) => (
            <div key={i} style={{ display: "flex", gap: 12, padding: 12 }}>
              <Skeleton width={22} height={22} />
              <Skeleton width={`${w * 100}%`} height={12} />
            </div>
          ))}
        </SkeletonGroup>
      ) : entries.length === 0 ? (
        <EmptyState icon="trash-2" title={t("files.trashEmpty")} description={t("files.trashEmptyText")} />
      ) : compact ? (
        <div role="list">
          {entries.map((e) => (
            <div key={e.file.id ?? e.file.name} role="listitem" style={styles.row}>
              <span style={{ flex: "none", width: 28, display: "flex", justifyContent: "center" }}>{icon(e)}</span>
              <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                <span style={{ display: "flex", fontSize: "var(--text-sm)", fontWeight: 500, color: "var(--text-strong)" }}>
                  <FileName name={e.file.name} isFolder={e.file.kind === "folder"} />
                </span>
                <span style={{ fontSize: "var(--text-2xs)", color: "var(--text-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {[e.deletedBy, formatStamp(e.deletedAt), where(e)].filter(Boolean).join(" · ")}
                </span>
              </span>
              {more(e)}
            </div>
          ))}
        </div>
      ) : (
        <div style={styles.wrap}>
          <table style={styles.table}>
            <colgroup>
              <col />
              <col style={{ width: 180 }} />
              <col style={{ width: 140 }} />
              <col style={{ width: 200 }} />
              <col style={{ width: 52 }} />
            </colgroup>
            <thead>
              <tr>
                <th style={styles.th}>{t("files.name")}</th>
                <th style={styles.th}>{t("files.deletedBy")}</th>
                <th style={styles.th}>{t("files.deletedOn")}</th>
                <th style={styles.th}>{t("files.originalLocation")}</th>
                <th style={styles.th} aria-label={t("files.actions")} />
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.file.id ?? e.file.name}>
                  <td style={styles.td}>
                    <span style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0, fontWeight: 500, color: "var(--text-strong)" }}>
                      {icon(e)}
                      <FileName name={e.file.name} isFolder={e.file.kind === "folder"} />
                    </span>
                  </td>
                  <td style={styles.td}>{e.deletedBy ?? ""}</td>
                  <td style={{ ...styles.td, color: "var(--text-muted)" }}>{formatStamp(e.deletedAt)}</td>
                  <td style={{ ...styles.td, color: "var(--text-muted)" }} title={e.originalFolderPresent ? undefined : t("files.originalGone")}>
                    {where(e)}
                    {e.originalFolderPresent ? "" : ` (${t("files.originalGoneShort")})`}
                  </td>
                  <td style={styles.td}>{more(e)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ActionMenu
        open={menu != null}
        at={menu?.at ?? null}
        title={menu?.entry.file.name ?? ""}
        entries={menu ? menuEntries(menu.entry) : []}
        sheet={compact}
        onClose={() => setMenu(null)}
      />
      <Dialog
        open={confirm != null}
        title={confirm?.kind === "all" ? t("files.emptyTrashTitle") : t("files.eraseTitle")}
        closeLabel={t("common.close")}
        size="sm"
        onClose={() => setConfirm(null)}
        footer={
          <>
            <Button onClick={() => setConfirm(null)}>{t("common.cancel")}</Button>
            <Button variant="danger" iconLeft="trash-2" onClick={confirmErase}>
              {confirm?.kind === "all" ? t("files.emptyTrash") : t("space.deleteConfirm")}
            </Button>
          </>
        }
      >
        <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--text-body)", lineHeight: "var(--leading-normal)" }}>
          {confirm?.kind === "all"
            ? t("files.emptyTrashBody", { count: manageable.length })
            : confirm
              ? t("files.eraseBody", { name: confirm.entry.file.name })
              : null}
        </p>
      </Dialog>
    </>
  );
}
