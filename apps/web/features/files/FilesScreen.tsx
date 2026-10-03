"use client";

import { type CSSProperties, useEffect, useId, useRef, useState } from "react";
import { FileViewer, viewerKind } from "./FileViewer";
import { ImageViewer } from "./ImageViewer";
import { Button, Dialog, EmptyState, FileIcon, type IconName, Skeleton, SkeletonGroup } from "@/components/ds";
import type { SpaceFile } from "@/lib/data";
import type { OfficeCapabilities } from "@/lib/data/types";
import { fileUrl } from "@/lib/spaceUrl";
import { OfficeEditor } from "@/features/office/OfficeEditor";
import { deleteFile, fileDownloadUrl, getInstanceCapabilities, officeActionFor, updateFile, uploadFile, uploadFileVersion } from "@/lib/data/api";
import { isApiError } from "@/lib/data/http";
import { useSettings } from "../app/settings";
import type { Toast } from "../app/types";
import { useTranslation } from "@/lib/i18n";
import { formatBytes, formatStamp } from "@/lib/i18n/format";
import { ActionMenu, type MenuEntry } from "./ActionMenu";
import { DetailsPanel, type DetailsSubject } from "./DetailsPanel";
import { DeleteDialog, RenameDialog } from "./FileDialogs";
import { FileGrid } from "./FileGrid";
import { FileRows } from "./FileRows";
import { FilesHeader, type Layout } from "./FilesHeader";
import { FileTable } from "./FileTable";
import { entryOf, type Item, type ListProps, type MenuAt } from "./listTypes";
import { type ActionId, actionsFor, canManage, filterEntries, type Sort, sortEntries } from "./model";
import { MoveDialog } from "./MoveDialog";
import { NewMenu } from "./NewMenu";
import { useDragMove } from "./useDragMove";
import { useFolder } from "./useFolder";
import { useSelection } from "./useSelection";

const styles: Record<string, CSSProperties> = {
  root: { position: "relative", flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 },
  main: { flex: 1, display: "flex", minHeight: 0, minWidth: 0 },
  body: { flex: 1, overflow: "auto", padding: 24, minWidth: 0 },
};

/** Each action's icon, the same in every menu. "open" is refined per entry (folder, editor, viewer). */
const ACTION_ICONS: Record<ActionId, IconName> = {
  open: "folder-open",
  download: "download",
  rename: "type",
  move: "arrow-right",
  newVersion: "upload",
  details: "info",
  delete: "trash-2",
};

/** Whether a file name looks like an image (drives the preview rendering). */
function isImage(name: string): boolean {
  return /\.(jpe?g|png|gif|webp|svg|heic)$/i.test(name);
}

/** Trigger a same-origin download without navigating away from the app. */
function download(fileId: string, name: string) {
  const a = document.createElement("a");
  a.href = fileDownloadUrl(fileId);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export type FilesScreenProps = {
  /** The space whose files are shown. */
  spaceId: string;
  workspaceName: string;
  /** The signed-in account, and its role in the space: together they decide who may manage what. */
  currentUserId?: string;
  spaceRole?: string;
  onNotify: (toast: Toast) => void;
  /** A phone: the way back to the tabs, at the start of the heading. */
  onBack?: () => void;
  /** Compact (phone) mode: rows instead of the table, sheets instead of menus, a floating "+". */
  compact?: boolean;
  /** The space's slug, for the editor's own address (none: the address is left alone). */
  spaceSlug?: string;
  /** Every slug the account belongs to, which decides the address's form. */
  slugs?: string[];
  /** The office editor opened or closed (it owns the address while open). */
  onEditorChange?: (open: boolean) => void;
};

/**
 * The space's files: a folder at a time, as a Drive shows it.
 *
 * This component assembles; each part has its own file. `model.ts` decides the order, the rights and
 * the actions; `useFolder` keeps the folder current; the table, the phone rows and the grid draw it;
 * `ActionMenu` offers each entry's actions wherever they are asked for (⋯, a right click, a long
 * press then ⋯); the dialogs carry out what needs confirming.
 */
export function FilesScreen({
  spaceId,
  workspaceName,
  currentUserId,
  spaceRole,
  onNotify,
  compact = false,
  onBack,
  spaceSlug,
  slugs,
  onEditorChange,
}: FilesScreenProps) {
  const { t } = useTranslation();
  const rootLabel = t("sidebar.spaceFiles");

  const { entries, breadcrumb, folderId, loading, load, reload } = useFolder(spaceId, () =>
    onNotify({ tone: "danger", title: t("files.loadFailed") }),
  );

  // Seeded from the preference on a desktop, then free to change for this visit. A phone starts on
  // the list, which fits a narrow screen; the grid stays one tap away.
  const settings = useSettings();
  const [layout, setLayout] = useState<Layout>(compact ? "list" : settings.filesLayout);
  const [sort, setSort] = useState<Sort>({ key: "name", dir: "asc" });
  const [q, setQ] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsSheet, setDetailsSheet] = useState<DetailsSubject | null>(null);
  const [menu, setMenu] = useState<{ item: Item; at: MenuAt } | null>(null);
  const [renaming, setRenaming] = useState<Item | null>(null);
  const [deleting, setDeleting] = useState<{ items: Item[]; skipped: number }>({ items: [], skipped: 0 });
  const [moving, setMoving] = useState<Item[]>([]);
  const [preview, setPreview] = useState<SpaceFile | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  /**
   * The file a new version is being picked for, and the input that picks it. The input is reached by
   * its id rather than a ref: the menus are built during render, and a ref read from a function
   * built there is one the compiler cannot tell from a ref read while rendering.
   */
  const versionInputId = useId();
  const pickVersion = () => document.getElementById(versionInputId)?.click();
  const [versionTarget, setVersionTarget] = useState<SpaceFile | null>(null);

  // What the office editor opens here, if the instance has one.
  const [office, setOffice] = useState<OfficeCapabilities | null>(null);
  /** The editor turned out to be unreachable: ask again every minute until it is back. */
  const [officeLost, setOfficeLost] = useState(false);
  const [officeCheck, setOfficeCheck] = useState(0);
  useEffect(() => {
    let cancelled = false;
    getInstanceCapabilities()
      .then((caps) => {
        if (cancelled) return;
        setOffice(caps.office.enabled ? caps.office : null);
        // Configured but not answering yet (an engine still starting): look again until it does.
        setOfficeLost(!caps.office.enabled && !!caps.office.publicUrl);
      })
      .catch(() => !cancelled && setOffice(null));
    return () => {
      cancelled = true;
    };
  }, [officeCheck]);
  useEffect(() => {
    if (!officeLost) return;
    const timer = window.setInterval(() => setOfficeCheck((n) => n + 1), 60_000);
    return () => window.clearInterval(timer);
  }, [officeLost]);
  /** The file open in the editor, and whether it is being converted rather than opened. */
  const [editing, setEditing] = useState<{ fileId: string; convert: boolean } | null>(null);
  const editorOpen = editing != null;
  useEffect(() => {
    onEditorChange?.(editorOpen);
  }, [editorOpen, onEditorChange]);
  // Leaving the files screen closes the editor with it.
  useEffect(() => () => onEditorChange?.(false), [onEditorChange]);

  /**
   * Open a document in the editor: in a tab of its own, as in any office suite, the list staying
   * here. Over the list instead on a phone (one screen, one thing at a time), in the installed app
   * (a new tab would leave it, and on iOS its session with it), when the space has no address, or
   * when the browser refuses the tab.
   */
  const opensInPlace =
    compact || (typeof window !== "undefined" && !!window.matchMedia?.("(display-mode: standalone)").matches);
  const openEditor = (fileId: string, convert: boolean, tab?: Window | null) => {
    const url = spaceSlug && !opensInPlace ? fileUrl(spaceSlug, fileId, slugs ?? [], convert) : null;
    const opened = tab !== undefined ? tab : url ? window.open(url, "_blank") : null;
    if (opened && url) {
      if (tab) opened.location.href = url;
      // The document's tab has no business with this one.
      try {
        opened.opener = null;
      } catch {
        // Not ours to change: nothing lost.
      }
      return;
    }
    opened?.close();
    setEditing({ fileId, convert });
  };

  // The list as shown: filtered, sorted, each entry with what this person may do with it.
  const items: Item[] = sortEntries(
    filterEntries(
      entries.map((f) => ({ ...entryOf(f), file: f })),
      q,
    ),
    sort,
  ).map(({ file }) => {
    const entry = entryOf(file);
    const manage = canManage(entry, currentUserId, spaceRole);
    return { key: file.id ?? file.name, file, entry, manage, actions: actionsFor(entry, manage) };
  });
  const selection = useSelection(items.map((i) => i.key));
  const selectedItems = items.filter((i) => selection.selected.has(i.key));

  // Another space is another drive: nothing selected, filtered or open carries over to it.
  const [shownSpace, setShownSpace] = useState(spaceId);
  if (shownSpace !== spaceId) {
    setShownSpace(spaceId);
    setQ("");
    selection.clear();
    setDetailsOpen(false);
    setPreview(null);
  }

  /** Open a folder: a new place, so no selection and no filter carried into it. */
  const openFolder = (id: string | undefined) => {
    selection.clear();
    setQ("");
    load(id);
  };
  /** Reload the folder after a change, dropping a selection that may name entries now gone. */
  const refresh = () => {
    selection.clear();
    reload();
  };

  /** What "open" does for a file: the editor, the full-page viewer, or the plain preview. */
  const opensInEditor = (f: SpaceFile) => {
    // A Word, Excel or PowerPoint file opens straight in the editor, as in any office suite; so does
    // a format only the editor can show (a Visio drawing). Everything else, and a PDF, is previewed,
    // where the editor stays one button away.
    const action = officeActionFor(f.name, office);
    return (action === "edit" && viewerKind(f.name) === "office") || (action === "view" && !viewerKind(f.name) && !isImage(f.name));
  };
  const openEntry = (item: Item) => {
    const f = item.file;
    if (item.entry.isFolder) {
      if (f.id) openFolder(f.id);
      return;
    }
    if (f.id && opensInEditor(f)) openEditor(f.id, false);
    else setPreview(f);
  };

  /** The entries an action on `item` applies to: the whole selection when `item` is part of it. */
  const groupOf = (item: Item) => (selection.selected.has(item.key) && selectedItems.length > 1 ? selectedItems : [item]);

  const requestDelete = (group: Item[]) => {
    const allowed = group.filter((i) => i.manage && i.file.id);
    if (allowed.length === 0) return;
    setDeleting({ items: allowed, skipped: group.length - allowed.length });
  };
  const requestMove = (group: Item[]) => {
    const allowed = group.filter((i) => i.manage && i.file.id);
    if (allowed.length > 0) setMoving(allowed);
  };
  const showDetails = (item: Item) => {
    if (compact) {
      setDetailsSheet({ kind: "entry", file: item.file });
    } else {
      selection.set([item.key]);
      setDetailsOpen(true);
    }
  };

  const runAction = (item: Item, action: ActionId) => {
    if (!item.actions.includes(action)) return;
    const f = item.file;
    switch (action) {
      case "open":
        return openEntry(item);
      case "download":
        if (f.id) download(f.id, f.name);
        return;
      case "rename":
        return setRenaming(item);
      case "move":
        return requestMove(groupOf(item));
      case "newVersion":
        setVersionTarget(f);
        pickVersion();
        return;
      case "details":
        return showDetails(item);
      case "delete":
        return requestDelete(groupOf(item));
    }
  };

  const actionLabel = (item: Item, action: ActionId): string => {
    switch (action) {
      case "open":
        if (item.entry.isFolder) return t("files.openAction");
        return opensInEditor(item.file) ? t("office.openInEditor") : t("files.previewAction");
      case "download":
        return t("message.download");
      case "rename":
        return t("files.rename");
      case "move":
        return t("files.move");
      case "newVersion":
        return t("files.uploadNewVersion");
      case "details":
        return t("files.details");
      case "delete":
        return t("common.delete");
    }
  };

  /** The menu for an entry, or for the whole selection when the entry is part of a larger one. */
  const menuEntries = (item: Item): MenuEntry[] => {
    const group = groupOf(item);
    if (group.length > 1) {
      const entries: MenuEntry[] = [];
      if (group.some((i) => i.manage)) entries.push({ label: t("files.move"), icon: "arrow-right", onSelect: () => requestMove(group) });
      if (group.some((i) => i.manage)) entries.push({ separator: true }, { label: t("common.delete"), icon: "trash-2", danger: true, onSelect: () => requestDelete(group) });
      return entries;
    }
    const out: MenuEntry[] = [];
    for (const action of item.actions) {
      // The removal stands apart from the rest, as it is the one that cannot be taken back here.
      if (action === "delete") out.push({ separator: true });
      if (action === "details" && out.length > 0) out.push({ separator: true });
      out.push({
        label: actionLabel(item, action),
        icon: action === "open" && !item.entry.isFolder ? (opensInEditor(item.file) ? "square-pen" : "eye") : ACTION_ICONS[action],
        danger: action === "delete",
        onSelect: () => runAction(item, action),
      });
    }
    return out;
  };

  const confirmDelete = () => {
    const targets = deleting.items;
    setDeleting({ items: [], skipped: 0 });
    if (targets.length === 0) return;
    // Settled rather than raced: one refusal must not hide the others, and a partial result still
    // needs the folder reloaded. A 403 is the one worth naming: the file belongs to someone else.
    Promise.allSettled(targets.map((i) => deleteFile(i.file.id as string))).then((results) => {
      const gone = results.filter((r) => r.status === "fulfilled").length;
      const refused = results.some((r) => r.status === "rejected" && isApiError(r.reason, 403));
      if (gone > 0) {
        onNotify({
          tone: "success",
          title: gone === 1 ? t("files.deleted") : t("files.deletedMany", { count: gone }),
          description: gone === 1 ? targets[0].file.name : undefined,
        });
      }
      if (gone < results.length) {
        onNotify({
          tone: "danger",
          title: t("files.deleteIncomplete"),
          description: refused ? t("files.ownFilesOnlyDelete") : t("common.tryAgain"),
        });
      }
      refresh();
    });
  };

  const confirmRename = (name: string) => {
    const item = renaming;
    setRenaming(null);
    if (!item?.file.id || name === item.file.name) return;
    updateFile(item.file.id, { name })
      .then(() => {
        onNotify({ tone: "success", title: t("files.renamed"), description: name });
        refresh();
      })
      .catch((err) =>
        onNotify({
          tone: "danger",
          title: t("files.renameFailed"),
          description: isApiError(err, 403) ? t("files.ownFilesOnlyRename") : t("files.renameHint"),
        }),
      );
  };

  /** Move entries into a folder (`null`: the space's root), from the dialog or a drop. */
  const moveTo = (targets: Item[], targetId: string | null, targetName: string) => {
    setMoving([]);
    if (targets.length === 0) return;
    Promise.allSettled(targets.map((i) => updateFile(i.file.id as string, { parentFolderId: targetId }))).then((results) => {
      const moved = results.filter((r) => r.status === "fulfilled").length;
      if (moved > 0) {
        onNotify({
          tone: "success",
          title: moved === 1 ? t("files.moved") : t("files.movedMany", { count: moved }),
          description: targetName,
        });
      }
      if (moved < results.length) {
        // The server refuses a folder moved into itself or into its own descendant.
        onNotify({ tone: "danger", title: t("files.moveIncomplete"), description: t("files.moveIntoItself") });
      }
      refresh();
    });
  };
  const folderName = (id: string | null) =>
    id == null ? rootLabel : (entries.find((f) => f.id === id)?.name ?? breadcrumb.find((c) => c.id === id)?.name ?? rootLabel);

  const drag = useDragMove({
    selectedItems,
    currentFolderId: folderId,
    onMove: (targets, targetId) => moveTo(targets, targetId, folderName(targetId)),
  });

  /** Replace a file's contents, keeping its name and its place. */
  const onVersionPicked = (input: HTMLInputElement) => {
    const file = input.files?.[0];
    const target = versionTarget;
    input.value = "";
    setVersionTarget(null);
    if (!file || !target?.id) return;
    onNotify({ tone: "info", title: t("files.uploadingVersion"), description: target.name });
    uploadFileVersion(target.id, file)
      .then((updated) => {
        onNotify({ tone: "success", title: t("files.versionUploaded", { version: updated.version }), description: target.name });
        refresh();
      })
      .catch((err) =>
        onNotify({
          tone: "danger",
          title: t("files.versionFailed"),
          description: isApiError(err, 403) ? t("files.ownFilesOnlyReplace") : target.name,
        }),
      );
  };

  const onFilePicked = (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (!file) return;
    if (uploadRef.current) uploadRef.current.value = "";
    onNotify({ tone: "info", title: t("files.uploading"), description: file.name });
    uploadFile(spaceId, file, folderId)
      .then(() => {
        onNotify({ tone: "success", title: t("files.uploaded"), description: file.name });
        refresh();
      })
      .catch(() => onNotify({ tone: "danger", title: t("files.uploadFailed"), description: file.name }));
  };

  const listProps: ListProps = {
    items,
    selected: selection.selected,
    sort,
    onSort: (key) => setSort((prev) => (prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "updatedAt" ? "desc" : "asc" })),
    onOpen: openEntry,
    onSelect: (item, mods) => selection.click(item.key, mods),
    onToggle: (item) => selection.toggle(item.key),
    onToggleAll: () => (items.length > 0 && items.every((i) => selection.selected.has(i.key)) ? selection.clear() : selection.selectAll()),
    onMenu: (item, at) => setMenu({ item, at }),
    onAction: (item, action) => runAction(item, action),
    onSelectAll: selection.selectAll,
    onClearSelection: selection.clear,
    drag: compact ? undefined : drag,
  };

  const currentName = breadcrumb.length > 0 ? breadcrumb[breadcrumb.length - 1].name : rootLabel;
  const detailsSubject: DetailsSubject =
    selectedItems.length === 1 ? { kind: "entry", file: selectedItems[0].file } : { kind: "folder", name: currentName, count: entries.length };

  const newMenu = (
    <NewMenu
      compact={compact}
      spaceId={spaceId}
      folderId={folderId}
      office={!!office}
      newTab={!opensInPlace}
      onNotify={onNotify}
      onUpload={() => uploadRef.current?.click()}
      onFolderCreated={refresh}
      onDocumentCreated={(file, tab) => {
        refresh();
        if (file.id) openEditor(file.id, false, tab);
        else tab?.close();
      }}
    />
  );

  const previewItem = preview ? items.find((i) => i.file.id === preview.id) : undefined;
  const previewManage = previewItem?.manage ?? false;

  return (
    <div style={styles.root}>
      <FilesHeader
        compact={compact}
        rootLabel={rootLabel}
        trail={breadcrumb}
        onOpenFolder={openFolder}
        onBack={onBack}
        drag={compact ? undefined : drag}
        query={q}
        onQuery={setQ}
        layout={layout}
        onLayout={setLayout}
        sort={sort}
        onSort={setSort}
        detailsOpen={detailsOpen}
        onToggleDetails={() => setDetailsOpen((v) => !v)}
        newButton={compact ? undefined : newMenu}
        selection={
          selectedItems.length > 0
            ? {
                count: selectedItems.length,
                canMove: selectedItems.some((i) => i.manage),
                canDelete: selectedItems.some((i) => i.manage),
                onMove: () => requestMove(selectedItems),
                onDelete: () => requestDelete(selectedItems),
                onClear: selection.clear,
              }
            : null
        }
      />
      <input ref={uploadRef} type="file" style={{ display: "none" }} onChange={(e) => onFilePicked(e.target.files)} />
      {/* A second picker, so choosing a replacement never runs through the one that creates a new
          file: the two differ only in where the bytes are sent, which is exactly the confusion
          worth designing out. */}
      <input id={versionInputId} type="file" style={{ display: "none" }} onChange={(e) => onVersionPicked(e.currentTarget)} />

      <div style={styles.main}>
        <div
          style={compact ? { ...styles.body, padding: layout === "grid" ? "12px 12px 96px" : "0 0 96px" } : styles.body}
          onClick={(e) => {
            // A click on the empty space around the list lets go of the selection, as on a desktop.
            if (e.target === e.currentTarget && !compact) selection.clear();
          }}
        >
          {items.length === 0 && loading ? (
            // Rows at the size of rows: the list lands where the placeholders were.
            <SkeletonGroup label={t("files.loading")} style={{ padding: "4px 0" }}>
              {[0.62, 0.45, 0.7, 0.38, 0.55].map((width, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px" }}>
                  <Skeleton width={22} height={22} />
                  <Skeleton width={`${width * 100}%`} height={12} />
                  <div style={{ flex: 1 }} />
                  <Skeleton width={64} height={10} />
                </div>
              ))}
            </SkeletonGroup>
          ) : items.length === 0 ? (
            <EmptyState
              icon={q ? "search" : breadcrumb.length > 0 ? "folder-open" : "folder"}
              title={q ? t("search.noResult") : breadcrumb.length > 0 ? t("files.emptyFolder") : t("files.noFile")}
              description={q ? t("files.noFileMatch", { query: q }) : breadcrumb.length > 0 ? t("files.folderEmptyText") : t("files.emptyText")}
              action={
                !q ? (
                  <Button size="sm" variant="primary" iconLeft="upload" onClick={() => uploadRef.current?.click()} style={{ flexShrink: 0 }}>
                    {t("files.upload")}
                  </Button>
                ) : undefined
              }
            />
          ) : layout === "grid" ? (
            <FileGrid {...listProps} touch={compact} />
          ) : compact ? (
            <FileRows {...listProps} />
          ) : (
            <FileTable {...listProps} />
          )}
        </div>
        {!compact && detailsOpen ? (
          <DetailsPanel subject={detailsSubject} trail={breadcrumb} rootLabel={rootLabel} sheet={false} onClose={() => setDetailsOpen(false)} />
        ) : null}
      </div>

      {/* The selection has its own bar; creating something new waits until it is let go. */}
      {compact && selectedItems.length === 0 ? newMenu : null}

      <ActionMenu
        open={menu != null}
        at={menu?.at ?? null}
        title={menu ? (groupOf(menu.item).length > 1 ? t("files.selectedCount", { count: groupOf(menu.item).length }) : menu.item.file.name) : ""}
        entries={menu ? menuEntries(menu.item) : []}
        sheet={compact}
        onClose={() => setMenu(null)}
      />
      {compact ? <DetailsPanel subject={detailsSheet} trail={breadcrumb} rootLabel={rootLabel} sheet onClose={() => setDetailsSheet(null)} /> : null}
      <RenameDialog item={renaming} onClose={() => setRenaming(null)} onRename={confirmRename} />
      <DeleteDialog items={deleting.items} skipped={deleting.skipped} onClose={() => setDeleting({ items: [], skipped: 0 })} onConfirm={confirmDelete} />
      <MoveDialog
        spaceId={spaceId}
        rootLabel={rootLabel}
        moving={moving}
        startFolderId={folderId}
        startTrail={breadcrumb}
        onNotify={onNotify}
        onClose={() => setMoving([])}
        onMove={(targetId) => moveTo(moving, targetId, folderName(targetId))}
      />

      {preview?.id && (isImage(preview.name) || viewerKind(preview.name)) ? (
        (() => {
          const target = preview;
          const actions = {
            onClose: () => setPreview(null),
            onDownload: () => download(target.id!, target.name),
            onNewVersion: previewManage
              ? () => {
                  setVersionTarget(target);
                  setPreview(null);
                  pickVersion();
                }
              : undefined,
            onDelete:
              previewManage && previewItem
                ? () => {
                    setPreview(null);
                    requestDelete([previewItem]);
                  }
                : undefined,
            onEdit:
              officeActionFor(target.name, office) === "edit"
                ? () => {
                    setPreview(null);
                    openEditor(target.id!, false);
                  }
                : undefined,
            onConvert:
              officeActionFor(target.name, office) === "convert"
                ? () => {
                    setPreview(null);
                    openEditor(target.id!, true);
                  }
                : undefined,
          };
          const kind = viewerKind(target.name);
          return kind ? (
            <FileViewer file={target} kind={kind} {...actions} />
          ) : (
            <ImageViewer file={target} images={items.map((i) => i.file).filter((f) => f.id && isImage(f.name))} onNavigate={setPreview} {...actions} />
          );
        })()
      ) : null}

      {/* A file nothing here can show: what it is, and the way to get it. */}
      <Dialog
        open={preview != null && !(preview.id && (isImage(preview.name) || viewerKind(preview.name)))}
        title={preview?.name}
        subtitle={
          preview
            ? t("files.previewMeta", { size: formatBytes(preview.sizeBytes), by: preview.modifiedBy ?? preview.by, when: formatStamp(preview.updatedAt) })
            : undefined
        }
        closeLabel={t("common.close")}
        size="md"
        onClose={() => setPreview(null)}
        footer={
          preview ? (
            <>
              <div style={{ flex: 1 }} />
              {preview.id && officeActionFor(preview.name, office) ? (
                <Button
                  iconLeft={officeActionFor(preview.name, office) === "view" ? "eye" : "square-pen"}
                  onClick={() => {
                    const id = preview.id!;
                    const convert = officeActionFor(preview.name, office) === "convert";
                    setPreview(null);
                    openEditor(id, convert);
                  }}
                >
                  {officeActionFor(preview.name, office) === "view"
                    ? t("office.openInEditor")
                    : officeActionFor(preview.name, office) === "convert"
                      ? t("office.convert")
                      : t("message.edit")}
                </Button>
              ) : null}
              <Button
                variant="primary"
                iconLeft="download"
                disabled={!preview.id}
                onClick={() => {
                  if (preview.id) download(preview.id, preview.name);
                }}
              >
                {t("message.download")}
              </Button>
            </>
          ) : null
        }
      >
        {preview ? (
          <div
            style={{
              height: 240,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--border-subtle)",
              background: "var(--surface-sunken)",
            }}
          >
            <FileIcon name={preview.name} size={72} />
            <div style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>{t("files.noPreview")}</div>
            <div style={{ fontSize: "var(--text-2xs)", color: "var(--text-subtle)" }}>{t("files.noPreviewText")}</div>
          </div>
        ) : null}
      </Dialog>

      {editing ? (
        <OfficeEditor
          key={`${editing.fileId}-${editing.convert}`}
          fileId={editing.fileId}
          convert={editing.convert}
          addressOf={spaceSlug ? (id, convert) => fileUrl(spaceSlug, id, slugs ?? [], convert) : undefined}
          onUnavailable={() => {
            // The engine is down: show the file the way it was shown before live editing.
            const file = entries.find((f) => f.id === editing.fileId);
            setEditing(null);
            setOffice(null);
            setOfficeLost(true);
            if (file) setPreview(file);
          }}
          onClose={() => {
            setEditing(null);
            // A conversion leaves a new file; a save, a new version.
            refresh();
          }}
        />
      ) : null}
    </div>
  );
}
