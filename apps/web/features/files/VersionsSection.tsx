"use client";

import { useEffect, useState } from "react";
import { IconButton, Skeleton, SkeletonGroup, Tag } from "@/components/ds";
import type { SpaceFile } from "@/lib/data";
import { type FileVersion, getVersions, restoreVersion, versionDownloadUrl } from "@/lib/data/api";
import { useTranslation } from "@/lib/i18n";
import { formatBytes, formatDateTime } from "@/lib/i18n/format";
import type { Toast } from "../app/types";

/**
 * A file's history, in its details: each version with who made it, when and how big, to download,
 * and an old one to bring back for whoever may replace the file. Bringing one back adds a version
 * (a copy of the old one), so nothing in the history is lost and it needs no confirmation.
 */
export function VersionsSection({
  file,
  canManage,
  onNotify,
  onRestored,
}: {
  file: SpaceFile;
  canManage: boolean;
  onNotify?: (toast: Toast) => void;
  /** The file after an old version came back, to show it in the list. */
  onRestored?: (file: SpaceFile) => void;
}) {
  const { t } = useTranslation();
  const [versions, setVersions] = useState<FileVersion[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Asked again when the file changes version (a save, an upload, a restore here or elsewhere).
  const stamp = `${file.id}:${file.versionNo ?? ""}`;

  useEffect(() => {
    if (!file.id) return;
    const ctrl = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the placeholder while the history loads
    setVersions(null);
    getVersions(file.id, ctrl.signal)
      .then(setVersions)
      .catch(() => !ctrl.signal.aborted && setVersions([]));
    return () => ctrl.abort();
    // `stamp` carries the id and the version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp]);

  const restore = (version: FileVersion) => {
    if (!file.id || busy) return;
    setBusy(version.id);
    restoreVersion(file.id, version.id)
      .then((updated) => {
        onNotify?.({
          tone: "success",
          title: t("files.versionRestored", { number: version.number }),
          description: t("files.versionRestoredHint", { number: updated.versionNo ?? version.number }),
        });
        onRestored?.(updated);
      })
      .catch(() => onNotify?.({ tone: "danger", title: t("files.versionRestoreFailed") }))
      .finally(() => setBusy(null));
  };

  return (
    <section style={{ marginTop: 22 }}>
      <h3 style={{ margin: "0 0 8px", fontSize: "var(--text-xs)", fontWeight: 700, color: "var(--text-strong)" }}>{t("files.versions")}</h3>
      {versions === null ? (
        <SkeletonGroup label={t("files.versionsLoading")}>
          {[0.7, 0.5].map((w, i) => (
            <div key={i} style={{ padding: "8px 0" }}>
              <Skeleton width={`${w * 100}%`} height={12} />
            </div>
          ))}
        </SkeletonGroup>
      ) : versions.length === 0 ? (
        <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>{t("files.noVersions")}</p>
      ) : (
        <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {versions.map((v) => (
            <li key={v.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderTop: "1px solid var(--border-subtle)" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--text-strong)" }}>
                  {t("files.versionNumber", { number: v.number })}
                  {v.current ? (
                    <Tag tone="info" mono>
                      {t("files.versionCurrent")}
                    </Tag>
                  ) : null}
                </div>
                <div style={{ fontSize: "var(--text-2xs)", color: "var(--text-muted)", overflowWrap: "anywhere" }}>
                  {[v.createdBy, formatDateTime(v.createdAt), formatBytes(v.sizeBytes)].filter(Boolean).join(" · ")}
                </div>
              </div>
              <IconButton
                icon="download"
                size="sm"
                label={t("files.downloadVersion", { number: v.number })}
                onClick={() => {
                  if (!file.id) return;
                  const a = document.createElement("a");
                  a.href = versionDownloadUrl(file.id, v.id);
                  a.download = file.name;
                  document.body.appendChild(a);
                  a.click();
                  a.remove();
                }}
              />
              {canManage && !v.current ? (
                <IconButton
                  icon="undo-2"
                  size="sm"
                  label={t("files.restoreVersion", { number: v.number })}
                  disabled={busy != null}
                  onClick={() => restore(v)}
                />
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
