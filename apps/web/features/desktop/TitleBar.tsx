"use client";

import { getCurrentWindow } from "@tauri-apps/api/window";
import { Icon } from "@/components/ds";
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
 * The top line of the window, part of the interface rather than a bar above it (Théo, 2026-10-21,
 * "like Slack"): the same background as the rail, no separating line, the global search in the
 * middle once an instance is signed in, and everywhere else a handle to move the window (double
 * click maximises; Tauri's drag region does it). The window's buttons sit on the right on Windows
 * and Linux; on macOS the system keeps its traffic lights, over the left end. Hidden in full screen.
 */
export function TitleBar({ maximized, onSearch }: { maximized: boolean; onSearch?: () => void }) {
  const { t } = useTranslation();
  const os = desktopOs();
  const win = getCurrentWindow();

  return (
    <header className={`wc-titlebar wc-titlebar--${os}`} data-tauri-drag-region>
      <div className="wc-titlebar__side" data-tauri-drag-region />
      <div className="wc-titlebar__middle" data-tauri-drag-region>
        {onSearch ? (
          <button type="button" className="wc-titlebar__search" onClick={onSearch}>
            <Icon name="search" size={14} aria-hidden />
            <span>{t("common.search")}</span>
          </button>
        ) : null}
      </div>
      <div className="wc-titlebar__side wc-titlebar__side--end" data-tauri-drag-region>
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
      </div>
    </header>
  );
}
