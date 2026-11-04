"use client";

import { Fragment, useState } from "react";
import { Icon } from "@/components/ds";
import { quitPreview } from "@/lib/data/api";
import type { Preview } from "@/lib/data/types";
import { useTranslation } from "@/lib/i18n";
import { bannerOf } from "./previewLogic.ts";
import type { Toast } from "./types";

/** A marker no translation contains: where the bold names go in the translated sentence. */
const MARK = "\u0001";

/**
 * The black band over the whole app while a space is looked at as a role (frame 13): who sees what,
 * that nothing can be written, how long it lasts without activity, and the way out. The band is the
 * only thing the preview adds; the screens below it are the role's own.
 */
export function PreviewBanner({ spaceId, spaceName, preview, onNotify }: { spaceId: string; spaceName: string; preview: Preview; onNotify: (toast: Toast) => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const words = bannerOf(preview, spaceName);
  const pieces = t("preview.banner", { space: `${MARK}space${MARK}`, role: `${MARK}role${MARK}` }).split(MARK);

  const quit = async () => {
    setBusy(true);
    try {
      await quitPreview(spaceId);
      // Everything on screen was read as the role: read it again as the person.
      window.location.reload();
    } catch {
      onNotify({ tone: "danger", title: t("preview.quitFailed") });
      setBusy(false);
    }
  };

  return (
    <div
      role="status"
      style={{ flex: "none", display: "flex", alignItems: "center", gap: 12, padding: "8px 16px", background: "#14161b", color: "#fff", fontSize: "var(--text-sm)" }}
    >
      <Icon name="eye" size={16} aria-hidden />
      <span style={{ flex: 1, minWidth: 0 }}>
        {pieces.map((piece, i) => (
          <Fragment key={i}>{i % 2 === 1 ? <b>{piece === "space" ? words.space : words.role}</b> : piece}</Fragment>
        ))}
      </span>
      <span style={{ fontSize: "var(--text-xs)", opacity: 0.8 }}>{t("preview.note", { minutes: words.minutes })}</span>
      {/* Its own colours: the design system's button takes the page's, dark on this dark band. */}
      <button
        type="button"
        disabled={busy}
        onClick={() => void quit()}
        style={{ flex: "none", border: 0, borderRadius: "var(--radius-md)", padding: "5px 14px", background: "#fff", color: "#14161b", font: "inherit", fontSize: "var(--text-sm)", fontWeight: 700, cursor: "pointer" }}
      >
        {t("preview.quit")}
      </button>
    </div>
  );
}
