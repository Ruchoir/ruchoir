"use client";

import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "@/lib/i18n";
import { desktopOs } from "@/lib/desktop/runtime";

/** The thin glyphs of a window's controls, drawn rather than taken from the icon set. */
function Glyph({ kind }: { kind: "minimize" | "maximize" | "restore" | "close" }) {
  const common = { width: 10, height: 10, viewBox: "0 0 10 10", fill: "none", stroke: "currentColor", strokeWidth: 1, "aria-hidden": true } as const;
  switch (kind) {
    case "minimize":
      return <svg {...common}><path d="M0 5.5h10" /></svg>;
    case "maximize":
      return <svg {...common}><rect x="0.5" y="0.5" width="9" height="9" /></svg>;
    case "restore":
      return (
        <svg {...common}>
          <rect x="0.5" y="2.5" width="7" height="7" />
          <path d="M2.5 2.5V0.5h7v7h-2" />
        </svg>
      );
    case "close":
      return <svg {...common}><path d="M0.5 0.5l9 9M9.5 0.5l-9 9" /></svg>;
  }
}

/**
 * The window's title bar, drawn by the interface since the window has no frame (Théo, 2026-10-20):
 * a drag region the height of the system's own (double click maximises, Tauri's drag region does it),
 * with the window's buttons on the right on Windows and Linux. On macOS the system keeps its traffic
 * lights, drawn over the left of this bar, which leaves them room. Hidden in full screen.
 */
export function TitleBar({ title }: { title: string }) {
  const { t } = useTranslation();
  const os = desktopOs();
  const [maximized, setMaximized] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    const read = () => {
      void win.isMaximized().then(setMaximized);
      void win.isFullscreen().then(setFullscreen);
    };
    read();
    const stop = win.onResized(read);
    return () => {
      void stop.then((unlisten) => unlisten());
    };
  }, []);

  if (fullscreen) return null;
  const win = getCurrentWindow();

  return (
    <header className={`wc-titlebar wc-titlebar--${os}`} data-tauri-drag-region>
      <span className="wc-titlebar__title" data-tauri-drag-region>
        {title}
      </span>
      {os === "macos" ? null : (
        <div className="wc-titlebar__controls">
          <button type="button" className="wc-titlebar__button" aria-label={t("desktop.titleBar.minimize")} onClick={() => void win.minimize()}>
            <Glyph kind="minimize" />
          </button>
          <button
            type="button"
            className="wc-titlebar__button"
            aria-label={maximized ? t("desktop.titleBar.restore") : t("desktop.titleBar.maximize")}
            onClick={() => void win.toggleMaximize()}
          >
            <Glyph kind={maximized ? "restore" : "maximize"} />
          </button>
          <button
            type="button"
            className="wc-titlebar__button wc-titlebar__button--close"
            aria-label={t("common.close")}
            onClick={() => void win.close()}
          >
            <Glyph kind="close" />
          </button>
        </div>
      )}
    </header>
  );
}
