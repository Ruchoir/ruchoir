"use client";

import { useEffect, useState } from "react";
import { Button, Dialog, Icon, IconButton, Input, Skeleton, SkeletonGroup } from "@/components/ds";
import type { SpaceFile } from "@/lib/data";
import { createFolder, getFolder } from "@/lib/data/api";
import { useTranslation } from "@/lib/i18n";
import type { Toast } from "../app/types";
import { blockedMoveTargets, middleTruncate, sortEntries } from "./model";
import { entryOf, type Item } from "./listTypes";
import type { Crumb } from "./useFolder";

/**
 * Choosing where entries go: the space's folders, walked one level at a time from the folder the
 * entries are in, as Drive and OneDrive do it. A folder being moved is greyed out (and so is all it
 * holds, being out of reach); "Move here" waits until the folder shown is somewhere new.
 */
export function MoveDialog({
  spaceId,
  rootLabel,
  moving,
  startFolderId,
  startTrail,
  onNotify,
  onClose,
  onMove,
}: {
  spaceId: string;
  rootLabel: string;
  /** What is being moved: entries the person may move. Empty when the dialog is closed. */
  moving: Item[];
  startFolderId?: string;
  startTrail: Crumb[];
  onNotify: (toast: Toast) => void;
  onClose: () => void;
  onMove: (targetFolderId: string | null) => void;
}) {
  const { t } = useTranslation();
  const open = moving.length > 0;
  const [place, setPlace] = useState<{ id?: string; trail: Crumb[] }>({ id: startFolderId, trail: startTrail });
  const [folders, setFolders] = useState<SpaceFile[] | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const blocked = blockedMoveTargets(moving.map((i) => i.entry));

  // Every opening starts from where the entries are.
  const [openedFor, setOpenedFor] = useState<Item[]>([]);
  if (open && openedFor !== moving) {
    setOpenedFor(moving);
    setPlace({ id: startFolderId, trail: startTrail });
    setNaming(null);
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a placeholder while the folder loads
    setFolders(null);
    getFolder(spaceId, place.id)
      .then((listing) => {
        if (cancelled) return;
        const only = listing.entries.filter((f) => f.kind === "folder");
        setFolders(sortEntries(only.map((f) => ({ ...entryOf(f), file: f })), { key: "name", dir: "asc" }).map((e) => e.file));
        setPlace((prev) => (prev.id === listing.folderId ? { ...prev, trail: listing.breadcrumb } : prev));
      })
      .catch(() => {
        if (cancelled) return;
        setFolders([]);
        onNotify({ tone: "danger", title: t("files.loadFailed") });
      });
    return () => {
      cancelled = true;
    };
    // `onNotify` and `t` are not reasons to reload the folder.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, spaceId, place.id]);

  const enter = (id: string | undefined) => setPlace({ id, trail: [] });
  const parent = place.trail.length > 1 ? place.trail[place.trail.length - 2].id : undefined;
  const sameFolder = moving.every((i) => (i.file.parentFolderId ?? undefined) === place.id);
  const here = place.trail.length > 0 ? place.trail[place.trail.length - 1].name : rootLabel;

  const submitFolder = () => {
    const name = naming?.trim();
    if (!name) return;
    setNaming(null);
    createFolder(spaceId, name, place.id)
      .then((folder) => folder.id && enter(folder.id))
      .catch(() => onNotify({ tone: "danger", title: t("files.folderFailed") }));
  };

  const title =
    moving.length === 1 ? t("files.moveOne", { name: middleTruncate(moving[0].file.name, 40) }) : t("files.moveMany", { count: moving.length });

  return (
    <Dialog
      open={open}
      title={title}
      closeLabel={t("common.close")}
      size="md"
      onClose={onClose}
      footer={
        <>
          <Button iconLeft="folder-plus" onClick={() => setNaming(t("files.newFolder"))} disabled={naming != null}>
            {t("files.newFolder")}
          </Button>
          <div style={{ flex: 1 }} />
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={sameFolder} onClick={() => onMove(place.id ?? null)}>
            {t("files.moveHere")}
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, minHeight: 40, marginBottom: 8 }}>
        {place.id ? <IconButton icon="arrow-left" label={t("common.back")} size="sm" onClick={() => enter(parent)} /> : null}
        <Icon name={place.id ? "folder-open" : "hard-drive"} size={16} style={{ color: "var(--text-muted)", flex: "none" }} />
        <span style={{ fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--text-strong)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {here}
        </span>
      </div>
      <div
        style={{
          height: 300,
          overflowY: "auto",
          border: "1.5px solid var(--border-subtle)",
          borderRadius: "var(--radius-md)",
          background: "var(--surface-card)",
        }}
      >
        {naming != null ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: 8, borderBottom: "1px solid var(--border-subtle)" }}>
            <Icon name="folder-plus" size={18} style={{ color: "var(--ink)", flex: "none" }} />
            <div style={{ flex: 1 }}>
              <Input
                size="sm"
                autoFocus
                aria-label={t("files.folderName")}
                value={naming}
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => setNaming(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitFolder();
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setNaming(null);
                  }
                }}
              />
            </div>
            <Button size="sm" variant="primary" onClick={submitFolder}>
              {t("common.create")}
            </Button>
          </div>
        ) : null}
        {folders === null ? (
          <SkeletonGroup label={t("files.loading")} style={{ padding: 8 }}>
            {[0.5, 0.35, 0.6].map((w, i) => (
              <div key={i} style={{ display: "flex", gap: 10, padding: "10px 8px" }}>
                <Skeleton width={18} height={18} />
                <Skeleton width={`${w * 100}%`} height={12} />
              </div>
            ))}
          </SkeletonGroup>
        ) : folders.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center", fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>{t("files.noSubfolder")}</div>
        ) : (
          folders.map((f) => {
            const off = !!f.id && blocked.has(f.id);
            return (
              <button
                key={f.id ?? f.name}
                type="button"
                disabled={off || !f.id}
                onClick={() => enter(f.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  width: "100%",
                  minHeight: 44,
                  padding: "0 12px",
                  border: 0,
                  borderBottom: "1px solid var(--border-subtle)",
                  background: "none",
                  font: "inherit",
                  fontSize: "var(--text-sm)",
                  color: off ? "var(--text-subtle)" : "var(--text-strong)",
                  cursor: off ? "not-allowed" : "pointer",
                  textAlign: "left",
                }}
              >
                <Icon name="folder" size={18} style={{ flex: "none", color: off ? "var(--text-subtle)" : "var(--ink)" }} />
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
                {off ? null : <Icon name="chevron-right" size={16} style={{ flex: "none", color: "var(--text-subtle)" }} />}
              </button>
            );
          })
        )}
      </div>
    </Dialog>
  );
}
