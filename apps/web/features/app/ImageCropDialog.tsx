"use client";

import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button, Dialog } from "@/components/ds";

/** Side of the exported image, in pixels. Matches what the API stores, so nothing is resampled twice. */
const EXPORT_PX = 512;

/** Side of the on-screen viewport. Large enough to judge a face, small enough for a `sm` dialog. */
const VIEWPORT_PX = 280;

const styles: Record<string, CSSProperties> = {
  body: { display: "flex", flexDirection: "column", gap: 16, alignItems: "center" },
  viewport: {
    position: "relative",
    width: VIEWPORT_PX,
    height: VIEWPORT_PX,
    overflow: "hidden",
    borderRadius: "var(--radius-lg)",
    background: "var(--surface-sunken)",
    border: "1px solid var(--border-subtle)",
    cursor: "grab",
    touchAction: "none",
  },
  hint: { fontSize: 12, color: "var(--text-muted)", textAlign: "center", maxWidth: 300 },
  zoom: { display: "flex", alignItems: "center", gap: 10, width: "100%" },
  zoomLabel: { fontSize: 12, color: "var(--text-muted)", flex: "none" },
};

export type ImageCropDialogProps = {
  /** The picked file. Read once into an object URL, revoked when the dialog closes. */
  file: File;
  title: string;
  onCancel: () => void;
  /** The cropped square, ready to upload. */
  onConfirm: (file: File) => void;
};

/**
 * Square crop step for an avatar or a space icon.
 *
 * Both are only ever displayed in a square, and the server crops to one whatever it receives, so
 * without this the framing is decided by nobody: a wide photo is silently reduced to its centre,
 * which is rarely where the subject is. Here the person chooses, by dragging and zooming, and the
 * canvas exports exactly what the viewport shows.
 *
 * The image never leaves the browser before it is cropped, so nothing larger than needed is
 * uploaded either. The export keeps transparency when there is any (PNG) and uses JPEG when there is
 * none, because a logo flattened into JPEG comes out on a black square.
 */
/** Whether anything drawn on the canvas is less than fully opaque. */
function hasTransparency(context: CanvasRenderingContext2D): boolean {
  const { data } = context.getImageData(0, 0, EXPORT_PX, EXPORT_PX);
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 255) return true;
  }
  return false;
}

export function ImageCropDialog({ file, title, onCancel, onConfirm }: ImageCropDialogProps) {
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  /**
   * Where the user dragged the image to, in screen pixels, or `null` while they have not.
   *
   * Stored raw and clamped at render rather than corrected in an effect: the valid range depends on
   * the zoom, so writing a corrected value back into state would mean re-running on every zoom step
   * and cascading a render each time. `null` is what lets the first frame be centred without an
   * effect either.
   */
  const [dragged, setDragged] = useState<{ x: number; y: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);

  // One object URL per file, revoked when it is replaced or the dialog closes, so no blob is held.
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  // The scale at which the image exactly covers the viewport; zoom multiplies it, so the viewport is
  // never left with a blank edge whatever the source aspect ratio.
  const cover = natural ? Math.max(VIEWPORT_PX / natural.width, VIEWPORT_PX / natural.height) : 1;
  const scale = cover * zoom;
  const drawn = natural ? { width: natural.width * scale, height: natural.height * scale } : null;

  // The position actually used, derived: centred until dragged, and always clamped so the image
  // covers the viewport. Zooming out therefore pulls the image back into frame on its own.
  const offset = drawn
    ? {
        x: Math.min(0, Math.max(VIEWPORT_PX - drawn.width, dragged?.x ?? (VIEWPORT_PX - drawn.width) / 2)),
        y: Math.min(0, Math.max(VIEWPORT_PX - drawn.height, dragged?.y ?? (VIEWPORT_PX - drawn.height) / 2)),
      }
    : { x: 0, y: 0 };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start) return;
    // Clamping happens on the way out, at render: this only records the intent.
    setDragged({ x: start.ox + (e.clientX - start.x), y: start.oy + (e.clientY - start.y) });
  };
  const endDrag = () => {
    drag.current = null;
  };

  /**
   * Export what the viewport shows.
   *
   * The source rectangle is the viewport expressed back in the image's own pixels, which is why the
   * offset is tracked in screen pixels and divided by the scale here rather than the other way
   * around: the arithmetic that positions the preview is the arithmetic that crops.
   */
  const confirm = () => {
    const image = imageRef.current;
    if (!image || !natural || busy) return;
    setBusy(true);
    const canvas = document.createElement("canvas");
    canvas.width = EXPORT_PX;
    canvas.height = EXPORT_PX;
    const context = canvas.getContext("2d");
    if (!context) {
      setBusy(false);
      return;
    }
    const side = VIEWPORT_PX / scale;
    context.drawImage(image, -offset.x / scale, -offset.y / scale, side, side, 0, 0, EXPORT_PX, EXPORT_PX);

    // JPEG cannot carry an alpha channel: encoding a transparent logo as one turns everything the
    // canvas left transparent into black. Whether that matters is decided by looking at the result
    // rather than at the file's type, since a PNG may well be fully opaque and does not need the
    // larger format. Reading the pixels back is safe here: the source is a local object URL, so the
    // canvas is same-origin and untainted.
    const transparent = hasTransparency(context);
    const type = transparent ? "image/png" : "image/jpeg";
    canvas.toBlob(
      (blob) => {
        setBusy(false);
        if (!blob) return;
        onConfirm(new File([blob], transparent ? "image.png" : "image.jpg", { type }));
      },
      type,
      0.9,
    );
  };

  return (
    <Dialog
      title={title}
      size="sm"
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>Annuler</Button>
          <Button variant="primary" disabled={!natural || busy} onClick={confirm}>
            {busy ? "Préparation…" : "Utiliser cette image"}
          </Button>
        </>
      }
    >
      <div style={styles.body}>
        <div
          style={styles.viewport}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- a local object URL, never remote */}
          <img
              ref={imageRef}
              src={url}
              alt=""
              draggable={false}
              onLoad={(e) =>
                setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })
              }
              style={{
                position: "absolute",
                left: offset.x,
                top: offset.y,
                width: drawn?.width,
                height: drawn?.height,
                maxWidth: "none",
                userSelect: "none",
              }}
            />
        </div>

        <div style={styles.zoom}>
          <span style={styles.zoomLabel}>Zoom</span>
          <input
            type="range"
            min={1}
            max={3}
            step={0.01}
            value={zoom}
            aria-label="Zoom"
            onChange={(e) => setZoom(Number(e.target.value))}
            style={{ flex: 1 }}
          />
        </div>
        <p style={styles.hint}>Faites glisser l&apos;image pour choisir ce qui reste dans le cadre.</p>
      </div>
    </Dialog>
  );
}
