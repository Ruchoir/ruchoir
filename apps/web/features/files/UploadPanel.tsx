"use client";

import { type CSSProperties, useState, useSyncExternalStore } from "react";
import { FileIcon, Icon, IconButton } from "@/components/ds";
import { useTranslation } from "@/lib/i18n";
import { formatBytes } from "@/lib/i18n/format";
import { cancel, cancelAll, clearFinished, getServerSnapshot, getSnapshot, retry, subscribe, type UploadJob } from "@/lib/uploads";
import { FileName } from "./FileName";

const styles: Record<string, CSSProperties> = {
  panel: {
    position: "fixed",
    zIndex: 40,
    display: "flex",
    flexDirection: "column",
    maxHeight: "min(420px, 60vh)",
    background: "var(--surface-raised)",
    border: "1px solid var(--border-default)",
    borderRadius: "var(--radius-md)",
    boxShadow: "var(--shadow-popover)",
    overflow: "hidden",
  },
  head: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    minHeight: 48,
    padding: "0 6px 0 14px",
    borderBottom: "1px solid var(--border-subtle)",
  },
  row: { display: "flex", alignItems: "center", gap: 10, padding: "8px 8px 8px 14px", borderBottom: "1px solid var(--border-subtle)" },
  bar: { height: 4, borderRadius: 2, background: "var(--surface-sunken)", overflow: "hidden", marginTop: 5 },
};

/**
 * The files being sent, wherever the person is in the app: one line each with its progress, a way
 * to stop it, and a way to send it again after a failure. Folded to its heading on request; closed
 * once nothing is under way.
 */
export function UploadPanel({ compact }: { compact: boolean }) {
  const { t } = useTranslation();
  const jobs = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [folded, setFolded] = useState(false);
  if (jobs.length === 0) return null;

  const busy = jobs.some((j) => j.status === "queued" || j.status === "uploading");
  const done = jobs.filter((j) => j.status === "done").length;
  const failed = jobs.filter((j) => j.status === "failed").length;
  const place: CSSProperties = compact
    ? // Above the floating "+" and the tabs, across the screen.
      { left: 8, right: 8, bottom: "calc(88px + env(safe-area-inset-bottom))" }
    : { right: 16, bottom: 16, width: 380 };

  return (
    <section style={{ ...styles.panel, ...place }} aria-label={t("files.uploadsLabel")}>
      <div style={styles.head}>
        <Icon
          name={busy ? "upload" : failed > 0 ? "alert-triangle" : "check"}
          size={16}
          style={{ flex: "none", color: !busy && failed > 0 ? "var(--status-danger-fg)" : "var(--text-muted)" }}
        />
        <span role="status" style={{ flex: 1, minWidth: 0, fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--text-strong)" }}>
          {t("files.uploadsProgress", { done, total: jobs.length })}
        </span>
        {busy ? (
          <button type="button" onClick={cancelAll} style={{ border: 0, background: "none", font: "inherit", fontSize: "var(--text-xs)", color: "var(--text-muted)", cursor: "pointer", padding: "6px 8px" }}>
            {t("files.cancelAll")}
          </button>
        ) : null}
        <IconButton
          icon={folded ? "chevron-up" : "chevron-down"}
          label={folded ? t("files.uploadsExpand") : t("files.uploadsCollapse")}
          size="sm"
          aria-expanded={!folded}
          onClick={() => setFolded((v) => !v)}
          style={compact ? { width: 40, height: 40 } : undefined}
        />
        {busy ? null : <IconButton icon="x" label={t("common.close")} size="sm" onClick={clearFinished} style={compact ? { width: 40, height: 40 } : undefined} />}
      </div>
      {folded ? null : (
        <div style={{ overflowY: "auto" }}>
          {jobs.map((job) => (
            <Row key={job.id} job={job} compact={compact} />
          ))}
        </div>
      )}
    </section>
  );
}

function Row({ job, compact }: { job: UploadJob; compact: boolean }) {
  const { t } = useTranslation();
  const percent = job.size > 0 ? Math.min(100, Math.round((job.loaded / job.size) * 100)) : 0;
  const failure =
    job.failure === "tooLarge"
      ? t("files.uploadTooLarge")
      : job.failure === "forbidden"
        ? t("files.uploadForbidden")
        : job.failure === "network"
          ? t("files.uploadNetwork")
          : t("files.uploadFailed");
  const status =
    job.status === "queued"
      ? t("files.uploadQueued")
      : job.status === "uploading"
        ? `${percent} % · ${formatBytes(job.size)}`
        : job.status === "done"
          ? job.replaceFileId
            ? t("files.uploadDoneVersion")
            : t("files.uploadDone")
          : job.status === "cancelled"
            ? t("files.uploadCancelled")
            : failure;
  const size = compact ? { width: 40, height: 40, flex: "none" as const } : { flex: "none" as const };

  return (
    <div style={styles.row}>
      <FileIcon name={job.name} size={24} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", fontSize: "var(--text-xs)", fontWeight: 500, color: "var(--text-strong)", minWidth: 0 }}>
          <FileName name={job.name} />
        </div>
        <div style={{ fontSize: "var(--text-2xs)", color: job.status === "failed" ? "var(--status-danger-fg)" : "var(--text-muted)" }}>{status}</div>
        {job.status === "uploading" ? (
          <div
            style={styles.bar}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-label={job.name}
          >
            <div style={{ width: `${percent}%`, height: "100%", background: "var(--text-accent)", transition: "width 200ms linear" }} />
          </div>
        ) : null}
      </div>
      {job.status === "queued" || job.status === "uploading" ? (
        <IconButton icon="x" label={t("files.cancelUpload", { name: job.name })} size="sm" onClick={() => cancel(job.id)} style={size} />
      ) : job.status === "done" ? (
        <Icon name="check" size={16} style={{ flex: "none", color: "var(--status-success-fg, var(--text-accent))", margin: "0 8px" }} />
      ) : job.failure === "tooLarge" ? null : (
        <IconButton icon="refresh-cw" label={t("files.retryUpload", { name: job.name })} size="sm" onClick={() => retry(job.id)} style={size} />
      )}
    </div>
  );
}
