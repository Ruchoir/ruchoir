"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { brandFor, Button, IconButton, Tag } from "@/components/ds";
import { fileDocumentUrl, filePreviewUrl } from "@/lib/data/api";
import type { SpaceFile } from "@/lib/data/types";
import { useTranslation } from "@/lib/i18n";
import { formatBytes, formatStamp } from "@/lib/i18n/format";

/**
 * How the viewer shows a file: a PDF goes to the browser's own viewer, an office document is
 * converted to PDF by the API first, and an image has a viewer of its own (`ImageViewer`).
 */
export type ViewerKind = "pdf" | "office";

const OFFICE = /\.(docx?|xlsx?|pptx?|odt|ods|odp|csv)$/i;

export function viewerKind(name: string): ViewerKind | null {
  if (/\.pdf$/i.test(name)) return "pdf";
  if (OFFICE.test(name)) return "office";
  return null;
}

/** Print a same-origin address (an image, say) through a hidden frame, leaving the app as it is. */
export function printUrl(url: string) {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;width:0;height:0;border:0;visibility:hidden";
  frame.onload = () => {
    try {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    } catch {
      window.open(url, "_blank", "noopener,noreferrer");
    }
    window.setTimeout(() => frame.remove(), 60_000);
  };
  frame.src = url;
  document.body.appendChild(frame);
}

/** The actions a viewer hands back to the files screen, which owns what they do. */
export type ViewerActions = {
  onClose: () => void;
  onDownload: () => void;
  onNewVersion: () => void;
  onDelete: () => void;
  /** Open the file in the office editor (absent: not offered). */
  onEdit?: () => void;
  /** Convert a legacy format into an editable copy (absent: not offered). */
  onConvert?: () => void;
};

export type FileViewerProps = ViewerActions & {
  file: SpaceFile;
  kind: ViewerKind;
};

/**
 * A document shown across the whole window, without leaving the app: the document on the left, a
 * side panel with its details and actions on the right, and the way out at the top right.
 */
export function FileViewer({ file, kind, onClose, onDownload, onNewVersion, onDelete, onEdit, onConvert }: FileViewerProps) {
  const { t } = useTranslation();
  const closeRef = useRef<HTMLButtonElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const print = () => {
    try {
      frameRef.current?.contentWindow?.focus();
      frameRef.current?.contentWindow?.print();
    } catch {
      if (file.id) window.open(kind === "pdf" ? filePreviewUrl(file.id) : fileDocumentUrl(file.id, file.updatedAt), "_blank", "noopener,noreferrer");
    }
  };

  const brand = brandFor(file.source) ?? undefined;
  const details: [string, string][] = [
    [t("files.size"), formatBytes(file.sizeBytes)],
    [t("files.modifiedBy"), file.by],
    [t("files.date"), formatStamp(file.updatedAt)],
  ];

  return (
    <div className="wc-viewer" role="dialog" aria-modal="true" aria-label={file.name}>
      <div className="wc-viewer__head">
        <div className="wc-viewer__title" title={file.name}>
          {file.name}
        </div>
        <IconButton ref={closeRef} icon="x" label={t("common.close")} onClick={onClose} />
      </div>
      <div className="wc-viewer__body">
        <div className="wc-viewer__doc">
          {file.id ? <DocumentFrame fileId={file.id} stamp={file.updatedAt} name={file.name} kind={kind} frameRef={frameRef} /> : null}
        </div>
        <aside className="wc-viewer__side" aria-label={t("files.details")}>
          <div className="wc-viewer__sideTitle">{t("files.details")}</div>
          <dl className="wc-viewer__facts">
            {details.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
            {file.version ? (
              <div>
                <dt>{t("files.version")}</dt>
                <dd>
                  <Tag mono tone="info">
                    {file.version}
                  </Tag>
                </dd>
              </div>
            ) : null}
            {file.imported ? (
              <div>
                <dt>{t("files.source")}</dt>
                <dd>
                  <Tag brand={brand} icon={brand ? undefined : "import"}>
                    {file.source !== "Ruchoir" ? file.source : t("common.imported")}
                  </Tag>
                </dd>
              </div>
            ) : null}
          </dl>
          <div className="wc-viewer__actions">
            {onEdit ? (
              <Button variant="primary" iconLeft="square-pen" fullWidth onClick={onEdit}>
                {t("message.edit")}
              </Button>
            ) : null}
            {onConvert ? (
              <Button iconLeft="refresh-cw" fullWidth onClick={onConvert} title={t("office.convertHint")}>
                {t("office.convert")}
              </Button>
            ) : null}
            <Button variant={onEdit ? "secondary" : "primary"} iconLeft="download" fullWidth onClick={onDownload}>
              {t("message.download")}
            </Button>
            <Button iconLeft="printer" fullWidth onClick={print}>
              {t("files.print")}
            </Button>
            <Button iconLeft="upload" fullWidth onClick={onNewVersion}>
              {t("files.newVersion")}
            </Button>
            <Button variant="danger" iconLeft="trash-2" fullWidth onClick={onDelete}>
              {t("common.delete")}
            </Button>
          </div>
        </aside>
      </div>
    </div>
  );
}

/**
 * The document itself, in a same-origin frame. An office file is fetched first: the API converts it
 * on the first open, which takes a while and can fail, and a frame would show neither the wait nor
 * the failure. The answer is kept by the browser, so the frame that follows does not ask again.
 */
function DocumentFrame({
  fileId,
  stamp,
  name,
  kind,
  frameRef,
}: {
  fileId: string;
  stamp: string;
  name: string;
  kind: ViewerKind;
  frameRef: RefObject<HTMLIFrameElement | null>;
}) {
  const { t } = useTranslation();
  const src = kind === "pdf" ? filePreviewUrl(fileId) : fileDocumentUrl(fileId, stamp);
  const [state, setState] = useState<"loading" | "ready" | "error">(kind === "pdf" ? "ready" : "loading");

  useEffect(() => {
    if (kind === "pdf") return;
    let cancelled = false;
    fetch(src)
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.blob();
      })
      .then(() => !cancelled && setState("ready"))
      .catch(() => !cancelled && setState("error"));
    return () => {
      cancelled = true;
    };
  }, [kind, src]);

  if (state === "loading") return <div className="wc-viewer__note">{t("files.convertingDocument")}</div>;
  if (state === "error") {
    return (
      <div className="wc-viewer__note">
        <strong>{t("files.noPreview")}</strong>
        <span>{t("files.noPreviewText")}</span>
      </div>
    );
  }
  return <iframe ref={frameRef} className="wc-viewer__frame" src={src} title={name} />;
}
