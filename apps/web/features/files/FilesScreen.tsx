"use client";

import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { Avatar, Button, Card, Checkbox, Dialog, EmptyState, Field, Icon, IconButton, Input, Tabs, Tag } from "@/components/ds";
import type { SpaceFile } from "@/lib/data";
import {
  createFolder as apiCreateFolder,
  deleteFile,
  fileDownloadUrl,
  filePreviewUrl,
  getFolder,
  updateFile,
  uploadFile,
  uploadFileVersion,
} from "@/lib/data/api";
import { isApiError } from "@/lib/data/http";
import { useSettings } from "../app/settings";
import type { Toast } from "../app/types";
import { getAvatar } from "@/lib/data";

const styles: Record<string, CSSProperties> = {
  root: { flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 },
  selectionBar: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flex: "none",
    padding: "8px 16px",
    borderBottom: "1px solid var(--border-subtle)",
    background: "var(--surface-selected)",
  },
  top: {
    height: "var(--topbar-height)",
    flex: "none",
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "0 12px 0 16px",
    borderBottom: "1px solid var(--border-subtle)",
  },
  crumb: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    margin: 0, // rendered as the page <h1> (breadcrumb heading)
    fontSize: 14,
    fontWeight: 600,
    color: "var(--text-strong)",
    letterSpacing: "var(--tracking-tight)",
  },
  body: { flex: 1, overflow: "auto", padding: "20px 24px" },
  bar: { display: "flex", alignItems: "center", gap: 10, marginBottom: 14 },
  tableWrap: {
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-md)",
    overflow: "hidden",
    background: "var(--surface-canvas)",
  },
  table: { width: "100%", borderCollapse: "collapse", tableLayout: "fixed" },
  th: {
    height: 34,
    textAlign: "left",
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: "var(--tracking-caps)",
    textTransform: "uppercase",
    color: "var(--text-subtle)",
    padding: "0 12px",
    background: "var(--grey-25)",
    borderBottom: "1px solid var(--border-subtle)",
    verticalAlign: "middle",
    whiteSpace: "nowrap",
  },
  td: {
    height: 44,
    padding: "0 12px",
    borderBottom: "1px solid var(--border-subtle)",
    fontSize: 13,
    color: "var(--text-body)",
    verticalAlign: "middle",
    overflow: "hidden",
  },
  checkCell: { display: "flex", alignItems: "center", justifyContent: "center" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(180px, 100%), 1fr))", gap: 12 },
  /** Fixed-height preview area, so cards stay aligned whatever each file turns out to be. */
  preview: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: 96,
    borderRadius: "var(--radius-md)",
    background: "var(--surface-sunken)",
    overflow: "hidden",
  },
  previewImage: { width: "100%", height: "100%", objectFit: "cover" },
};

/** Parse a French-formatted size ("248 Ko", "3,4 Mo") into bytes; unknown shapes yield 0. */
function sizeToBytes(size: string): number {
  const match = size.match(/([\d,]+)\s*(Ko|Mo|Go)/);
  if (!match) return 0;
  const value = Number(match[1].replace(",", "."));
  const unit = { Ko: 1e3, Mo: 1e6, Go: 1e9 }[match[2]] ?? 1;
  return value * unit;
}

/** Format a byte count back into a French-formatted size string. */
function bytesToSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1).replace(".", ",")} Go`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1).replace(".", ",")} Mo`;
  return `${Math.max(1, Math.round(bytes / 1e3))} Ko`;
}

/** Shorten a file name from the middle so the extension stays visible (e.g. "Rapproche…mars.csv"). */
function truncateMiddle(name: string, max = 22): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 6 ? name.slice(dot) : "";
  const base = ext ? name.slice(0, name.length - ext.length) : name;
  const keep = Math.max(4, max - ext.length - 1);
  return `${base.slice(0, keep)}…${ext}`;
}

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
  currentUser: string;
  onNotify: (toast: Toast) => void;
  /** Compact (mobile) mode: force the card grid (the wide table cannot fit) and let the toolbar wrap. */
  compact?: boolean;
};

/** The space files view, backed by the API (folder tree, upload, download, preview). */
export function FilesScreen({ spaceId, workspaceName, onNotify, compact = false }: FilesScreenProps) {
  const [entries, setEntries] = useState<SpaceFile[]>([]);
  const [breadcrumb, setBreadcrumb] = useState<{ id: string; name: string }[]>([]);
  const [folderId, setFolderId] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [tab, setTab] = useState("Tous");
  // Seeded from the preference, then free to change for this visit: a default is a starting point,
  // not a lock.
  const settings = useSettings();
  const [layout, setLayout] = useState<"list" | "grid">(settings.filesLayout);
  // The 7-column table cannot fit a phone; force the responsive card grid on compact.
  const effectiveLayout = compact ? "grid" : layout;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [folderOpen, setFolderOpen] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [preview, setPreview] = useState<SpaceFile | null>(null);
  // What a confirmed removal would take. Held as the entries themselves, so the dialog can name
  // them and warn about a folder, which takes everything under it.
  const [pendingDelete, setPendingDelete] = useState<SpaceFile[]>([]);
  /** The entry being renamed, and the name as typed. */
  const [renaming, setRenaming] = useState<{ entry: SpaceFile; name: string } | null>(null);
  /**
   * Entries picked up for a move, kept while the folder browser is used to choose where.
   *
   * The destination is chosen by walking to it, which is the navigation this screen already has,
   * rather than by a second tree inside a dialog. It survives `load`, which clears the selection.
   */
  const [moving, setMoving] = useState<SpaceFile[]>([]);
  const uploadRef = useRef<HTMLInputElement>(null);
  /** The file a new version is being picked for, and the input that picks it. */
  const versionRef = useRef<HTMLInputElement>(null);
  const [versionTarget, setVersionTarget] = useState<SpaceFile | null>(null);

  // `onNotify` (AppRoot's toast) is a fresh function each parent render; keep the latest in a ref so
  // `load` stays stable across renders (otherwise the load effect below refires every render, which
  // loops a failing fetch and never lets the network go idle).
  const onNotifyRef = useRef(onNotify);
  useEffect(() => {
    onNotifyRef.current = onNotify;
  });

  /** Load a folder (the space root when `id` is undefined) and reset the local view state. */
  const load = useCallback(
    (id?: string) => {
      setLoading(true);
      getFolder(spaceId, id)
        .then((listing) => {
          setEntries(listing.entries);
          setBreadcrumb(listing.breadcrumb);
          setFolderId(listing.folderId);
          setSelected(new Set());
          setLoading(false);
        })
        .catch(() => {
          setEntries([]);
          setLoading(false);
          onNotifyRef.current({ tone: "danger", title: "Chargement des fichiers impossible" });
        });
    },
    [spaceId],
  );

  useEffect(() => {
    // Load the space root on mount (and when the space changes). Data fetch on mount is the point.
    /* eslint-disable react-hooks/set-state-in-effect */
    load(undefined);
    setQ("");
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [load]);

  const currentFolderName = breadcrumb.length > 0 ? breadcrumb[breadcrumb.length - 1].name : null;
  const parentId = breadcrumb.length > 1 ? breadcrumb[breadcrumb.length - 2].id : undefined;

  const rows = entries
    .filter((f) => f.name.toLowerCase().includes(q.toLowerCase()))
    .filter((f) => tab === "Tous" || (tab === "Importés" ? !!f.imported : f.kind === "folder"));

  const openEntry = (f: SpaceFile) => {
    if (f.kind === "folder") {
      if (f.id) load(f.id);
    } else {
      setPreview(f);
    }
  };

  const totalBytes = rows.reduce((sum, f) => sum + sizeToBytes(f.size), 0);
  const rowKey = (f: SpaceFile) => f.id ?? f.name;
  const allSelected = rows.length > 0 && rows.every((f) => selected.has(rowKey(f)));

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rows.map(rowKey)));

  // The selection as entries rather than keys: a removal needs the id and the name, and a key is
  // only a name when the entry has no id.
  const selectedEntries = rows.filter((f) => f.id && selected.has(rowKey(f)));

  const createFolder = () => {
    const name = folderName.trim();
    if (!name) return;
    setFolderName("");
    setFolderOpen(false);
    apiCreateFolder(spaceId, name, folderId)
      .then(() => {
        onNotify({ tone: "success", title: "Dossier créé", description: name });
        load(folderId);
      })
      .catch(() => onNotify({ tone: "danger", title: "Création du dossier impossible" }));
  };

  /**
   * Remove the entries the dialog is holding.
   *
   * Settled rather than raced: one refusal must not hide the others, and a partial result still
   * needs the folder reloaded. A 403 is the one worth naming, since it means the file belongs to
   * someone else rather than that anything went wrong.
   */
  const confirmDelete = () => {
    const targets = pendingDelete;
    setPendingDelete([]);
    if (targets.length === 0) return;
    Promise.allSettled(targets.filter((f) => f.id).map((f) => deleteFile(f.id as string)))
      .then((results) => {
        const gone = results.filter((r) => r.status === "fulfilled").length;
        const refused = results.some((r) => r.status === "rejected" && isApiError(r.reason, 403));
        if (gone > 0) {
          onNotify({
            tone: "success",
            title: gone === 1 ? "Élément supprimé" : `${gone} éléments supprimés`,
            description: gone === 1 ? targets[0].name : undefined,
          });
        }
        if (gone < results.length) {
          onNotify({
            tone: "danger",
            title: "Suppression incomplète",
            description: refused
              ? "Vous ne pouvez supprimer que vos propres fichiers, sauf si vous administrez l'espace."
              : "Réessayez dans un instant.",
          });
        }
        load(folderId);
      });
  };

  const confirmRename = () => {
    const entry = renaming?.entry;
    const name = renaming?.name.trim() ?? "";
    if (!entry?.id) return;
    setRenaming(null);
    if (!name || name === entry.name) return;
    updateFile(entry.id, { name })
      .then(() => {
        onNotify({ tone: "success", title: "Renommé", description: name });
        load(folderId);
      })
      .catch((err) =>
        onNotify({
          tone: "danger",
          title: "Renommage impossible",
          description: isApiError(err, 403)
            ? "Vous ne pouvez renommer que vos propres fichiers, sauf si vous administrez l'espace."
            : "Ce nom n'est peut-être pas utilisable.",
        }),
      );
  };

  /** Drop the entries being moved into the folder currently open. */
  const confirmMove = () => {
    const targets = moving;
    setMoving([]);
    if (targets.length === 0) return;
    Promise.allSettled(
      targets.filter((f) => f.id).map((f) => updateFile(f.id as string, { parentFolderId: folderId ?? null })),
    ).then((results) => {
      const moved = results.filter((r) => r.status === "fulfilled").length;
      if (moved > 0) {
        onNotify({
          tone: "success",
          title: moved === 1 ? "Élément déplacé" : `${moved} éléments déplacés`,
          description: currentFolderName ?? workspaceName,
        });
      }
      if (moved < results.length) {
        onNotify({
          tone: "danger",
          title: "Déplacement incomplet",
          // The server refuses a folder moved into itself or into its own descendant, which is the
          // one mistake this way of choosing a destination makes easy.
          description: "Un dossier ne peut pas être déplacé dans lui-même.",
        });
      }
      load(folderId);
    });
  };

  /** Replace a file's contents, keeping its name and its place. */
  const onVersionPicked = (fileList: FileList | null) => {
    const file = fileList?.[0];
    const target = versionTarget;
    if (versionRef.current) versionRef.current.value = "";
    setVersionTarget(null);
    if (!file || !target?.id) return;
    onNotify({ tone: "info", title: "Envoi de la nouvelle version", description: target.name });
    uploadFileVersion(target.id, file)
      .then((updated) => {
        onNotify({ tone: "success", title: `Version ${updated.version} déposée`, description: target.name });
        load(folderId);
      })
      .catch((err) =>
        onNotify({
          tone: "danger",
          title: "Version non déposée",
          description: isApiError(err, 403)
            ? "Vous ne pouvez remplacer que vos propres fichiers, sauf si vous administrez l'espace."
            : target.name,
        }),
      );
  };

  const onFilePicked = (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (!file) return;
    if (uploadRef.current) uploadRef.current.value = "";
    onNotify({ tone: "info", title: "Dépôt en cours", description: file.name });
    uploadFile(spaceId, file, folderId)
      .then(() => {
        onNotify({ tone: "success", title: "Fichier déposé", description: file.name });
        load(folderId);
      })
      .catch(() => onNotify({ tone: "danger", title: "Dépôt impossible", description: file.name }));
  };

  return (
    <div style={styles.root}>
      <div
        style={
          compact
            ? { ...styles.top, height: "auto", minHeight: "var(--topbar-height)", flexWrap: "wrap", rowGap: 8, padding: "8px 12px" }
            : styles.top
        }
      >
        {/* Page heading: the file location, as a breadcrumb. */}
        <h1 style={styles.crumb}>
          <Icon name="hard-drive" size={15} style={{ color: "var(--text-muted)" }} />
          {currentFolderName ? (
            <button
              type="button"
              onClick={() => load(undefined)}
              style={{ border: 0, background: "none", padding: 0, cursor: "pointer", font: "inherit", color: "var(--text-muted)", fontWeight: 400 }}
            >
              {workspaceName}
            </button>
          ) : (
            <>
              Fichiers de l&apos;espace
              <Icon name="chevron-right" size={13} style={{ color: "var(--text-subtle)" }} />
              <span style={{ fontWeight: 400, color: "var(--text-muted)" }}>{workspaceName}</span>
            </>
          )}
          {currentFolderName ? (
            <>
              <Icon name="chevron-right" size={13} style={{ color: "var(--text-subtle)" }} />
              <span>{currentFolderName}</span>
            </>
          ) : null}
        </h1>
        <div style={{ flex: compact ? "1 0 100%" : 1 }} />
        <Button size="sm" iconLeft="folder-plus" onClick={() => setFolderOpen(true)}>
          Nouveau dossier
        </Button>
        <Button size="sm" variant="primary" iconLeft="upload" onClick={() => uploadRef.current?.click()}>
          Déposer un fichier
        </Button>
        <input ref={uploadRef} type="file" style={{ display: "none" }} onChange={(e) => onFilePicked(e.target.files)} />
        {/* A second picker, so choosing a replacement never runs through the one that creates a new
            file: the two differ only in where the bytes are sent, which is exactly the confusion
            worth designing out. */}
        <input
          ref={versionRef}
          type="file"
          style={{ display: "none" }}
          onChange={(e) => onVersionPicked(e.target.files)}
        />
      </div>

      <div style={styles.body}>
        {currentFolderName ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 14,
              padding: "10px 12px",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius-md)",
              background: "var(--surface-sunken)",
            }}
          >
            <Button size="sm" variant="secondary" iconLeft="arrow-left" onClick={() => load(parentId)}>
              Retour
            </Button>
            <Icon name="folder" size={18} style={{ color: "var(--terracotta-500)" }} />
            <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-strong)" }}>{currentFolderName}</span>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>· {rows.length} élément{rows.length > 1 ? "s" : ""}</span>
          </div>
        ) : null}
        <div style={{ ...styles.bar, flexWrap: compact ? "wrap" : "nowrap" }}>
          <div style={{ width: compact ? "100%" : 280 }}>
            <Input size="sm" icon="search" placeholder="Filtrer les fichiers" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <Tabs
            variant="pills"
            value={tab}
            onChange={setTab}
            items={[
              { value: "Tous", label: "Tous" },
              { value: "Dossiers", label: "Dossiers" },
              { value: "Importés", label: "Importés" },
            ]}
          />
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {rows.length} élément{rows.length > 1 ? "s" : ""}
            {totalBytes > 0 ? ` · ${bytesToSize(totalBytes)}` : ""}
          </span>
          {!compact ? (
            <>
              <IconButton icon="layout-grid" label="Vue en grille" size="sm" aria-pressed={layout === "grid"} onClick={() => setLayout("grid")} />
              <IconButton icon="list" label="Vue en liste" size="sm" aria-pressed={layout === "list"} onClick={() => setLayout("list")} />
            </>
          ) : null}
        </div>

        {moving.length > 0 ? (
          // A move in progress takes over the bar: the destination is chosen by walking to it, so
          // this has to stay visible and actionable while the folders are being browsed.
          <div style={styles.selectionBar}>
            <Icon name="folder-open" size={15} style={{ color: "var(--text-accent)" }} />
            <span style={{ fontSize: 13, color: "var(--text-strong)" }}>
              <strong>
                {moving.length} élément{moving.length > 1 ? "s" : ""}
              </strong>{" "}
              à déplacer : ouvrez le dossier de destination.
            </span>
            <div style={{ flex: 1 }} />
            <Button size="sm" onClick={() => setMoving([])}>
              Annuler
            </Button>
            <Button size="sm" variant="primary" iconLeft="folder-plus" onClick={confirmMove}>
              Déplacer ici
            </Button>
          </div>
        ) : selectedEntries.length > 0 ? (
          // The checkboxes had built a selection nothing could act on. This is what they are for.
          <div style={styles.selectionBar}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-strong)" }}>
              {selectedEntries.length} sélectionné{selectedEntries.length > 1 ? "s" : ""}
            </span>
            <div style={{ flex: 1 }} />
            <Button size="sm" onClick={() => setSelected(new Set())}>
              Annuler
            </Button>
            <Button
              size="sm"
              iconLeft="folder-open"
              onClick={() => {
                setMoving(selectedEntries);
                setSelected(new Set());
              }}
            >
              Déplacer
            </Button>
            <Button size="sm" variant="danger" iconLeft="trash-2" onClick={() => setPendingDelete(selectedEntries)}>
              Supprimer
            </Button>
          </div>
        ) : null}

        {effectiveLayout === "list" ? (
          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <colgroup>
                <col style={{ width: 44 }} />
                <col />
                <col style={{ width: 84 }} />
                <col style={{ width: 150 }} />
                <col style={{ width: 120 }} />
                <col style={{ width: 116 }} />
                <col style={{ width: 52 }} />
              </colgroup>
              <thead>
                <tr>
                  <th style={styles.th}>
                    <span style={styles.checkCell}>
                      <Checkbox checked={allSelected} onChange={toggleAll} aria-label="Tout sélectionner" />
                    </span>
                  </th>
                  <th style={styles.th}>Nom</th>
                  <th style={styles.th}>Version</th>
                  <th style={styles.th}>Modifié par</th>
                  <th style={styles.th}>Date</th>
                  <th style={styles.th}>Source</th>
                  <th style={styles.th} aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {rows.map((f) => (
                  <FileRow
                    key={rowKey(f)}
                    f={f}
                    checked={selected.has(rowKey(f))}
                    onToggle={() => toggle(rowKey(f))}
                    onOpen={() => openEntry(f)}
                    onDelete={f.id ? () => setPendingDelete([f]) : undefined}
                    onRename={f.id ? () => setRenaming({ entry: f, name: f.name }) : undefined}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={styles.grid}>
            {rows.map((f) => (
              <Card
                key={rowKey(f)}
                variant="interactive"
                padded
                onClick={() => openEntry(f)}
                style={{ display: "flex", flexDirection: "column", gap: 8, cursor: "pointer" }}
              >
                {/* A card is big enough to show what the file is, so show it: the API already stored
                    a thumbnail at upload, and an icon says far less than the picture itself. */}
                <div style={styles.preview}>
                  {f.thumbnailUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- same-origin, served by our own API
                    <img src={f.thumbnailUrl} alt="" loading="lazy" style={styles.previewImage} />
                  ) : (
                    <Icon
                      name={f.kind}
                      size={26}
                      style={{ color: f.kind === "folder" ? "var(--terracotta-500)" : "var(--text-muted)" }}
                    />
                  )}
                </div>
                <div title={f.name} style={{ fontSize: 13, fontWeight: 500, color: "var(--text-strong)", whiteSpace: "nowrap", overflow: "hidden" }}>
                  {truncateMiddle(f.name)}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-muted)" }}>
                  <Avatar name={f.by} src={getAvatar(f.by)} size={18} />
                  {f.size}
                </div>
                {f.imported ? <Tag icon="import">{f.source !== "Ruchoir" ? f.source : "Importé"}</Tag> : null}
              </Card>
            ))}
          </div>
        )}

        {rows.length === 0 ? (
          <EmptyState
            icon={loading ? "loader" : q ? "search" : currentFolderName ? "folder-open" : "folder"}
            title={loading ? "Chargement…" : q ? "Aucun résultat" : currentFolderName ? "Dossier vide" : "Aucun fichier"}
            description={
              loading
                ? "Récupération des fichiers de l'espace."
                : q
                  ? `Aucun fichier ne correspond à « ${q} ».`
                  : currentFolderName
                    ? "Ce dossier ne contient aucun fichier pour l'instant."
                    : "Déposez vos premiers fichiers, ou reprenez-les depuis Slack, Mattermost ou Nextcloud lors d'un import."
            }
            action={
              !q && !loading ? (
                <Button size="sm" variant="primary" iconLeft="upload" onClick={() => uploadRef.current?.click()}>
                  Déposer un fichier
                </Button>
              ) : undefined
            }
          />
        ) : null}
      </div>

      <Dialog
        open={folderOpen}
        title="Nouveau dossier"
        size="sm"
        onClose={() => setFolderOpen(false)}
        footer={
          <>
            <Button onClick={() => setFolderOpen(false)}>Annuler</Button>
            <Button variant="primary" onClick={createFolder}>
              Créer
            </Button>
          </>
        }
      >
        <Field label="Nom du dossier" htmlFor="fname">
          <Input
            id="fname"
            autoFocus
            placeholder="ex. Factures 2026"
            value={folderName}
            onChange={(e) => setFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") createFolder();
            }}
          />
        </Field>
      </Dialog>

      <Dialog
        open={renaming != null}
        title="Renommer"
        size="sm"
        onClose={() => setRenaming(null)}
        footer={
          <>
            <Button onClick={() => setRenaming(null)}>Annuler</Button>
            <Button variant="primary" onClick={confirmRename}>
              Renommer
            </Button>
          </>
        }
      >
        <Field label="Nom" htmlFor="rename">
          <Input
            id="rename"
            autoFocus
            value={renaming?.name ?? ""}
            onChange={(e) => setRenaming((prev) => (prev ? { ...prev, name: e.target.value } : prev))}
            onKeyDown={(e) => {
              if (e.key === "Enter") confirmRename();
            }}
          />
        </Field>
      </Dialog>

      <Dialog
        open={pendingDelete.length > 0}
        title={pendingDelete.length > 1 ? `Supprimer ${pendingDelete.length} éléments ?` : "Supprimer cet élément ?"}
        size="sm"
        onClose={() => setPendingDelete([])}
        footer={
          <>
            <Button onClick={() => setPendingDelete([])}>Annuler</Button>
            <Button variant="danger" iconLeft="trash-2" onClick={confirmDelete}>
              Supprimer
            </Button>
          </>
        }
      >
        <p style={{ fontSize: 14, color: "var(--text-body)", lineHeight: "var(--leading-normal)" }}>
          {pendingDelete.length === 1 ? (
            <>
              <strong style={{ color: "var(--text-strong)" }}>{pendingDelete[0].name}</strong> sera retiré de
              l&apos;espace.
            </>
          ) : (
            <>Ces éléments seront retirés de l&apos;espace.</>
          )}
          {pendingDelete.some((f) => f.kind === "folder")
            ? " Un dossier emporte tout ce qu'il contient."
            : ""}
        </p>
      </Dialog>

      <Dialog
        open={preview != null}
        title={preview?.name}
        subtitle={preview ? `${preview.size} · modifié par ${preview.by} · ${preview.when}` : undefined}
        size="lg"
        onClose={() => setPreview(null)}
        footer={
          preview ? (
            <>
              {preview.imported ? <Tag icon="import">{preview.source !== "Ruchoir" ? preview.source : "Importé"}</Tag> : null}
              {preview.version ? (
                <Tag mono tone="info">
                  {preview.version}
                </Tag>
              ) : null}
              <div style={{ flex: 1 }} />
              {preview.id ? (
                <Button
                  iconLeft="upload"
                  onClick={() => {
                    setVersionTarget(preview);
                    setPreview(null);
                    versionRef.current?.click();
                  }}
                >
                  Nouvelle version
                </Button>
              ) : null}
              {preview.id ? (
                <Button
                  variant="danger"
                  iconLeft="trash-2"
                  onClick={() => {
                    const target = preview;
                    setPreview(null);
                    setPendingDelete([target]);
                  }}
                >
                  Supprimer
                </Button>
              ) : null}
              <Button onClick={() => setPreview(null)}>Fermer</Button>
              <Button
                variant="primary"
                iconLeft="download"
                disabled={!preview.id}
                onClick={() => {
                  if (preview.id) download(preview.id, preview.name);
                }}
              >
                Télécharger
              </Button>
            </>
          ) : null
        }
      >
        {preview ? (
          <div
            style={{
              height: 320,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--border-subtle)",
              background: "var(--surface-sunken)",
              overflow: "hidden",
            }}
          >
            {preview.id && isImage(preview.name) ? (
              // eslint-disable-next-line @next/next/no-img-element -- same-origin API bytes, not a Next asset
              <img
                src={filePreviewUrl(preview.id)}
                alt={preview.name}
                style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
              />
            ) : (
              <>
                <Icon name={isImage(preview.name) ? "image" : preview.kind === "folder" ? "folder" : preview.kind} size={52} style={{ color: "var(--text-subtle)" }} />
                <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Aperçu indisponible</div>
                <div style={{ fontSize: 12, color: "var(--text-subtle)" }}>Téléchargez le fichier pour l&apos;ouvrir.</div>
              </>
            )}
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}

function FileRow({
  f,
  checked,
  onToggle,
  onOpen,
  onDelete,
  onRename,
}: {
  f: SpaceFile;
  checked: boolean;
  onToggle: () => void;
  onOpen: () => void;
  /** Both absent for an entry the API cannot address, which is the only case with no id. */
  onDelete?: () => void;
  onRename?: () => void;
}) {
  const [hover, setHover] = useState(false);
  const isFolder = f.kind === "folder";
  return (
    <tr
      style={{ background: hover || checked ? "var(--surface-hover)" : "transparent" }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <td style={styles.td}>
        <span style={styles.checkCell}>
          <Checkbox checked={checked} onChange={onToggle} aria-label={`Sélectionner ${f.name}`} />
        </span>
      </td>
      <td style={styles.td}>
        <span
          role="button"
          tabIndex={0}
          onClick={onOpen}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onOpen()}
          style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0, cursor: "pointer" }}
        >
          <Icon name={f.kind} size={17} style={{ flex: "none", color: isFolder ? "var(--terracotta-500)" : "var(--text-muted)" }} />
          <span style={{ fontWeight: 500, color: "var(--text-strong)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {f.name}
          </span>
        </span>
      </td>
      <td style={styles.td}>{f.version ? <Tag mono tone="info">{f.version}</Tag> : null}</td>
      <td style={styles.td}>
        <span style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
          <Avatar name={f.by} src={getAvatar(f.by)} size={20} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.by.split(" ")[0]}</span>
        </span>
      </td>
      <td style={{ ...styles.td, color: "var(--text-muted)", fontSize: 12 }}>{f.when}</td>
      <td style={styles.td}>
        {f.imported ? <Tag icon="import">{f.source !== "Ruchoir" ? f.source : "Importé"}</Tag> : <span style={{ fontSize: 12, color: "var(--text-subtle)" }}>-</span>}
      </td>
      <td style={styles.td}>
        <span style={{ ...styles.checkCell, opacity: hover ? 1 : 0, transition: "opacity var(--duration-fast) var(--ease-out)" }}>
          <IconButton
            icon={isFolder ? "folder-open" : "eye"}
            label={isFolder ? `Ouvrir ${f.name}` : `Aperçu de ${f.name}`}
            size="sm"
            tabIndex={hover ? 0 : -1}
            onClick={onOpen}
          />
          {onRename ? (
            <IconButton
              icon="square-pen"
              label={`Renommer ${f.name}`}
              size="sm"
              tabIndex={hover ? 0 : -1}
              onClick={onRename}
            />
          ) : null}
          {onDelete ? (
            <IconButton
              icon="trash-2"
              label={`Supprimer ${f.name}`}
              size="sm"
              tabIndex={hover ? 0 : -1}
              onClick={onDelete}
            />
          ) : null}
        </span>
      </td>
    </tr>
  );
}
