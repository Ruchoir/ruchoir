"use client";

import { useEffect, useState } from "react";
import { IconButton, IconLink } from "@/components/ds";
import type { InlineImage as InlineImageData } from "@/lib/data";

/**
 * A sample chart drawn as inline SVG. Stands in for a real uploaded image: this exploration
 * never loads remote bytes (sovereignty + CSP), so media is generated locally.
 */
function SampleChart({ rounded }: { rounded?: number }) {
  const bars = [40, 72, 55, 88, 63, 96, 70];
  const w = 520;
  const h = 300;
  const pad = 36;
  const base = h - pad;
  const step = (w - pad * 2) / bars.length;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      width="100%"
      role="presentation"
      style={{ display: "block", borderRadius: rounded, background: "var(--surface-sunken)" }}
    >
      <line x1={pad} y1={base} x2={w - pad} y2={base} stroke="var(--border-strong)" strokeWidth={1} />
      {bars.map((v, i) => {
        const bh = (v / 100) * (base - pad);
        const x = pad + i * step + step * 0.2;
        return (
          <rect
            key={i}
            x={x}
            y={base - bh}
            width={step * 0.6}
            height={bh}
            rx={3}
            fill={i === 5 ? "var(--terracotta-500)" : "var(--grey-300)"}
          />
        );
      })}
    </svg>
  );
}

export function InlineImage({ image }: { image: InlineImageData }) {
  const [open, setOpen] = useState(false);
  const displayWidth = Math.min(image.width, 460);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label={`Agrandir l'image : ${image.alt}`}
        style={{
          display: "block",
          marginTop: 8,
          width: displayWidth,
          maxWidth: "100%",
          padding: 0,
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--radius-lg)",
          overflow: "hidden",
          background: "none",
          cursor: "zoom-in",
        }}
      >
        {image.src ? (
          // eslint-disable-next-line @next/next/no-img-element -- same-origin, served by our own API
          <img
            src={image.src}
            alt={image.alt}
            width={image.width}
            height={image.height}
            style={{ display: "block", width: "100%", height: "auto" }}
          />
        ) : (
          // No source yet: an optimistic message whose upload has not been acknowledged.
          <SampleChart rounded={0} />
        )}
      </button>

      {open ? (
        <div
          onClick={() => setOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label={image.alt}
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            // Compensated for the text-size zoom (see globals.css) so the lightbox fills the screen.
            width: "var(--ui-vw, 100vw)",
            height: "var(--ui-vh, 100dvh)",
            zIndex: 80,
            background: "var(--scrim)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 40,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ position: "relative", width: "min(880px, calc(0.9 * var(--ui-vw, 100vw)))" }}
          >
            <div style={{ position: "absolute", top: -44, right: 0, display: "flex", gap: 8 }}>
              {/* Full quality in a tab, and saving the original: the lightbox shows the image
                  scaled to the viewport, which is not the same thing as having the file. */}
              {image.src ? (
                <IconLink
                  icon="external-link"
                  label="Ouvrir dans un nouvel onglet"
                  variant="outlined"
                  href={image.src}
                  target="_blank"
                  rel="noopener noreferrer"
                />
              ) : null}
              {image.downloadUrl ? (
                <IconLink
                  icon="download"
                  label="Télécharger l'image"
                  variant="outlined"
                  href={image.downloadUrl}
                  download
                />
              ) : null}
              <IconButton icon="x" label="Fermer" variant="outlined" onClick={() => setOpen(false)} />
            </div>
            <div style={{ borderRadius: "var(--radius-lg)", overflow: "hidden", boxShadow: "var(--shadow-dialog)" }}>
              {image.src ? (
                // eslint-disable-next-line @next/next/no-img-element -- same-origin, served by our own API
                <img src={image.src} alt={image.alt} style={{ display: "block", width: "100%", height: "auto" }} />
              ) : (
                <SampleChart />
              )}
            </div>
            <div style={{ marginTop: 10, textAlign: "center", fontSize: 13, color: "var(--text-inverse)" }}>
              {image.alt}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
