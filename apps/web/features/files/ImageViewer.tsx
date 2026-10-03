"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { IconButton } from "@/components/ds";
import { filePreviewUrl } from "@/lib/data/api";
import type { SpaceFile } from "@/lib/data/types";
import { useTranslation } from "@/lib/i18n";
import { formatBytes } from "@/lib/i18n/format";
import { printUrl, type ViewerActions } from "./FileViewer";

const MIN_SCALE = 1;
const MAX_SCALE = 8;
const STEP = 1.4;

export type ImageViewerProps = ViewerActions & {
  file: SpaceFile;
  /** The images of the folder, in the order shown, to walk through with the arrows. */
  images: SpaceFile[];
  onNavigate: (file: SpaceFile) => void;
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * The picture on a dark backdrop, made for looking rather than for managing: zoom with the wheel,
 * the keys or two fingers, drag to move around, double click to go in and out, and the arrows to
 * walk through the folder's other images. The actions sit in small floating bars.
 */
export function ImageViewer({ file, images, onNavigate, onClose, onDownload, onNewVersion, onDelete }: ImageViewerProps) {
  const { t } = useTranslation();
  const index = images.findIndex((f) => f.id === file.id);
  const prev = index > 0 ? images[index - 1] : null;
  const next = index >= 0 && index < images.length - 1 ? images[index + 1] : null;
  const [zoom, setZoom] = useState({ scale: 1, x: 0, y: 0 });
  const [broken, setBroken] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; scale: number } | null>(null);

  // A new picture starts fitted to the window.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset when the shown file changes
    setZoom({ scale: 1, x: 0, y: 0 });
    setBroken(false);
  }, [file.id]);

  /** Zoom to `scale`, keeping the point under (`cx`,`cy`), relative to the window centre, where it is. */
  const zoomTo = useCallback((scale: number, cx = 0, cy = 0) => {
    setZoom((z) => {
      const s = clamp(scale, MIN_SCALE, MAX_SCALE);
      if (s === MIN_SCALE) return { scale: s, x: 0, y: 0 };
      const k = s / z.scale;
      return { scale: s, x: cx - (cx - z.x) * k, y: cy - (cy - z.y) * k };
    });
  }, []);

  const go = useCallback(
    (target: SpaceFile | null) => {
      if (target) onNavigate(target);
    },
    [onNavigate],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") go(prev);
      else if (e.key === "ArrowRight") go(next);
      else if (e.key === "+" || e.key === "=") zoomTo(zoom.scale * STEP);
      else if (e.key === "-") zoomTo(zoom.scale / STEP);
      else if (e.key === "0") zoomTo(1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, go, prev, next, zoomTo, zoom.scale]);

  const centre = (clientX: number, clientY: number) => {
    const r = stage.current?.getBoundingClientRect();
    return r ? { cx: clientX - (r.left + r.width / 2), cy: clientY - (r.top + r.height / 2) } : { cx: 0, cy: 0 };
  };

  const onWheel = (e: React.WheelEvent) => {
    const { cx, cy } = centre(e.clientX, e.clientY);
    zoomTo(zoom.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15), cx, cy);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale: zoom.scale };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const last = pointers.current.get(e.pointerId);
    if (!last) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const mid = centre((a.x + b.x) / 2, (a.y + b.y) / 2);
      zoomTo((pinch.current.scale * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.current.dist, mid.cx, mid.cy);
    } else if (pointers.current.size === 1 && zoom.scale > 1) {
      setZoom((z) => ({ ...z, x: z.x + e.clientX - last.x, y: z.y + e.clientY - last.y }));
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  };

  if (!file.id) return null;
  const url = filePreviewUrl(file.id);

  return (
    <div className="wc-imgv" role="dialog" aria-modal="true" aria-label={file.name}>
      <div
        ref={stage}
        className="wc-imgv__stage"
        data-zoomed={zoom.scale > 1 ? "true" : undefined}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={(e) => {
          const { cx, cy } = centre(e.clientX, e.clientY);
          zoomTo(zoom.scale > 1 ? 1 : 2.5, cx, cy);
        }}
        onClick={(e) => {
          // A click on the backdrop, not on the picture, closes it.
          if (e.target === e.currentTarget && zoom.scale === 1) onClose();
        }}
      >
        {broken ? (
          <div className="wc-imgv__broken">
            <strong>{t("files.noPreview")}</strong>
            <span>{t("files.noPreviewText")}</span>
          </div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- same-origin API bytes, not a Next asset
          <img
            className="wc-imgv__img"
            src={url}
            alt={file.name}
            draggable={false}
            onError={() => setBroken(true)}
            style={{ transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})` }}
          />
        )}
      </div>

      <div className="wc-imgv__top">
        <div className="wc-imgv__name">
          <span title={file.name}>{file.name}</span>
          <small>
            {index >= 0 && images.length > 1 ? `${index + 1} / ${images.length} · ` : ""}
            {formatBytes(file.sizeBytes)}
          </small>
        </div>
        <div className="wc-imgv__bar">
          <IconButton icon="printer" label={t("files.print")} onClick={() => file.id && printUrl(url)} />
          <IconButton icon="download" label={t("message.download")} onClick={onDownload} />
          {onNewVersion ? <IconButton icon="upload" label={t("files.newVersion")} onClick={onNewVersion} /> : null}
          {onDelete ? <IconButton icon="trash-2" label={t("common.delete")} onClick={onDelete} /> : null}
          <IconButton icon="x" label={t("common.close")} onClick={onClose} />
        </div>
      </div>

      {prev ? (
        <div className="wc-imgv__nav wc-imgv__nav--prev wc-imgv__bar">
          <IconButton icon="chevron-left" label={t("files.previousImage")} onClick={() => go(prev)} />
        </div>
      ) : null}
      {next ? (
        <div className="wc-imgv__nav wc-imgv__nav--next wc-imgv__bar">
          <IconButton icon="chevron-right" label={t("files.nextImage")} onClick={() => go(next)} />
        </div>
      ) : null}

      <div className="wc-imgv__zoom wc-imgv__bar">
        <IconButton icon="zoom-out" label={t("files.zoomOut")} onClick={() => zoomTo(zoom.scale / STEP)} disabled={zoom.scale <= MIN_SCALE} />
        <button type="button" className="wc-imgv__pct" onClick={() => zoomTo(1)} aria-label={t("files.zoomFit")} title={t("files.zoomFit")}>
          {Math.round(zoom.scale * 100)} %
        </button>
        <IconButton icon="zoom-in" label={t("files.zoomIn")} onClick={() => zoomTo(zoom.scale * STEP)} disabled={zoom.scale >= MAX_SCALE} />
        <IconButton icon="maximize" label={t("files.zoomFit")} onClick={() => zoomTo(1)} disabled={zoom.scale === 1} />
      </div>
    </div>
  );
}
