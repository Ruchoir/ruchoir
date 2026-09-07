"use client";

import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { Avatar, Button, Card, Checkbox, Dialog, EmptyState, Field, Icon, IconButton, Input, Tabs, Tag } from "@/components/ds";
import type { SpaceFile } from "@/lib/data";
import { createFolder as apiCreateFolder, fileDownloadUrl, filePreviewUrl, getFolder, uploadFile } from "@/lib/data/api";
import { useSettings } from "../app/settings";
import type { Toast } from "../app/types";
import { getAvatar } from "@/lib/data";

const styles: Record<string, CSSProperties> = {
  root: { flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 },
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
  const uploadRef = useRef<HTMLInputElement>(null);

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
}: {
  f: SpaceFile;
  checked: boolean;
  onToggle: () => void;
  onOpen: () => void;
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
        </span>
      </td>
    </tr>
  );
}
