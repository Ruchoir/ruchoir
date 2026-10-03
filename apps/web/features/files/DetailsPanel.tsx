"use client";

import type { CSSProperties, ReactNode } from "react";
import { FileIcon, Icon, IconButton, Sheet } from "@/components/ds";
import type { SpaceFile } from "@/lib/data";
import { type TranslationKey, key, useTranslation } from "@/lib/i18n";
import { formatBytes, formatDateTime } from "@/lib/i18n/format";
import type { Toast } from "../app/types";
import type { Crumb } from "./useFolder";
import { VersionsSection } from "./VersionsSection";

/** A file's kind as a person names it, from its extension. */
const TYPE_BY_EXTENSION: Record<string, TranslationKey> = {
  doc: key("office.kindDocument"),
  docx: key("office.kindDocument"),
  odt: key("office.kindDocument"),
  rtf: key("office.kindDocument"),
  txt: key("files.typeText"),
  md: key("files.typeText"),
  xls: key("office.kindSpreadsheet"),
  xlsx: key("office.kindSpreadsheet"),
  ods: key("office.kindSpreadsheet"),
  csv: key("office.kindSpreadsheet"),
  ppt: key("office.kindPresentation"),
  pptx: key("office.kindPresentation"),
  odp: key("office.kindPresentation"),
  pdf: key("files.typePdf"),
  png: key("files.typeImage"),
  jpg: key("files.typeImage"),
  jpeg: key("files.typeImage"),
  gif: key("files.typeImage"),
  webp: key("files.typeImage"),
  svg: key("files.typeImage"),
  heic: key("files.typeImage"),
  zip: key("files.typeArchive"),
  "7z": key("files.typeArchive"),
  tar: key("files.typeArchive"),
  gz: key("files.typeArchive"),
};

const styles: Record<string, CSSProperties> = {
  aside: {
    width: 320,
    flex: "none",
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    borderLeft: "1.5px solid var(--border-subtle)",
    background: "var(--surface-card)",
  },
  head: {
    height: 52,
    flex: "none",
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "0 8px 0 16px",
    borderBottom: "1px solid var(--border-subtle)",
  },
  preview: {
    height: 160,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-md)",
    background: "var(--surface-sunken)",
    overflow: "hidden",
    marginBottom: 14,
  },
  dl: { display: "grid", gridTemplateColumns: "auto 1fr", columnGap: 14, rowGap: 10, margin: 0, fontSize: "var(--text-xs)" },
  dt: { color: "var(--text-muted)", whiteSpace: "nowrap" },
  dd: { margin: 0, color: "var(--text-body)", minWidth: 0, overflowWrap: "anywhere" },
};

/** What the panel describes: one entry, or the folder open when nothing is selected. */
export type DetailsSubject = { kind: "entry"; file: SpaceFile } | { kind: "folder"; name: string; count: number };

/**
 * Everything the list leaves out, for one entry: its kind, size, place, owner, dates, version and,
 * for a migrated file, where it came from. A column beside the list on a desktop, which it pushes
 * rather than covers; a sheet on a phone.
 */
export function DetailsPanel({
  subject,
  trail,
  rootLabel,
  sheet,
  onClose,
  canManage = false,
  onNotify,
  onVersionRestored,
}: {
  subject: DetailsSubject | null;
  /** Where the list is, which is where the entry lives. */
  trail: Crumb[];
  rootLabel: string;
  sheet: boolean;
  onClose: () => void;
  /** Whether this person may replace the file (bring an old version back). */
  canManage?: boolean;
  onNotify?: (toast: Toast) => void;
  onVersionRestored?: (file: SpaceFile) => void;
}) {
  const { t } = useTranslation();
  const title = subject ? (subject.kind === "entry" ? subject.file.name : subject.name) : t("files.details");
  const body = subject ? (
    <>
      <Body subject={subject} trail={trail} rootLabel={rootLabel} />
      {subject.kind === "entry" && subject.file.id && subject.file.kind !== "folder" ? (
        <VersionsSection file={subject.file} canManage={canManage} onNotify={onNotify} onRestored={onVersionRestored} />
      ) : null}
    </>
  ) : null;

  if (sheet) {
    return (
      <Sheet open={subject != null} label={title} heading onClose={onClose}>
        <div style={{ padding: "4px 16px 16px" }}>{body}</div>
      </Sheet>
    );
  }
  return (
    <aside style={styles.aside} aria-label={t("files.details")}>
      <div style={styles.head}>
        <Icon name="info" size={16} style={{ color: "var(--text-muted)", flex: "none" }} />
        <h2 title={title} style={{ flex: 1, minWidth: 0, margin: 0, fontSize: "var(--text-sm)", fontWeight: 700, color: "var(--text-strong)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {title}
        </h2>
        <IconButton icon="x" label={t("common.close")} size="sm" onClick={onClose} />
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>{body}</div>
    </aside>
  );
}

function Body({ subject, trail, rootLabel }: { subject: DetailsSubject; trail: Crumb[]; rootLabel: string }) {
  const { t } = useTranslation();
  const location = [rootLabel, ...trail.map((c) => c.name)].join(" › ");
  const rows: [string, ReactNode][] = [];

  if (subject.kind === "folder") {
    rows.push([t("files.type"), t("files.typeFolder")], [t("files.content"), t("files.count", { count: subject.count })]);
    return (
      <>
        <div style={styles.preview}>
          <Icon name="folder-open" size={44} style={{ color: "var(--ink)" }} />
        </div>
        <Rows rows={rows} />
      </>
    );
  }

  const f = subject.file;
  const isFolder = f.kind === "folder";
  const ext = f.name.includes(".") ? f.name.slice(f.name.lastIndexOf(".") + 1).toLowerCase() : "";
  const typeKey = isFolder ? key("files.typeFolder") : (TYPE_BY_EXTENSION[ext] ?? key("message.file"));
  rows.push([t("files.type"), ext && !isFolder ? `${t(typeKey)} (${ext.toUpperCase()})` : t(typeKey)]);
  rows.push(isFolder ? [t("files.content"), t("files.count", { count: f.childCount ?? 0 })] : [t("files.size"), formatBytes(f.sizeBytes)]);
  rows.push([t("files.location"), location]);
  if (f.by) rows.push([t("role.owner"), f.by]);
  if (f.createdAt) rows.push([t("files.created"), formatDateTime(f.createdAt)]);
  rows.push([
    t("files.modified"),
    f.modifiedBy ? t("files.modifiedOnBy", { when: formatDateTime(f.updatedAt), who: f.modifiedBy }) : formatDateTime(f.updatedAt),
  ]);
  if (!isFolder && f.version) rows.push([t("files.version"), f.version]);
  if (f.imported) rows.push([t("files.origin"), f.source !== "Ruchoir" ? t("files.importedFrom", { source: f.source }) : t("common.imported")]);
  if (f.editors && f.editors.length > 0) rows.push([t("files.editing"), f.editors.map((e) => e.name).join(", ")]);

  return (
    <>
      <div style={styles.preview}>
        {f.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- same-origin, served by our own API
          <img src={f.thumbnailUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
        ) : isFolder ? (
          <Icon name="folder" size={44} style={{ color: "var(--ink)" }} />
        ) : (
          <FileIcon name={f.name} size={64} />
        )}
      </div>
      <Rows rows={rows} />
    </>
  );
}

function Rows({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl style={styles.dl}>
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: "contents" }}>
          <dt style={styles.dt}>{label}</dt>
          <dd style={styles.dd}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
