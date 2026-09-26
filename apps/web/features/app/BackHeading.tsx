"use client";

import type { CSSProperties, ReactNode } from "react";
import { IconButton } from "@/components/ds";
import { useTranslation } from "@/lib/i18n";

/**
 * A view's heading bar with the phone's way back at its start. The view keeps its own heading (its
 * `<h1>` and whatever it draws beside it); on a phone this adds the arrow before it instead of the
 * shell stacking a second bar above, which cost a sixth of the screen to say the name twice.
 *
 * `bar` is the view's own bar style: it moves to the wrapper, and the heading inside it only grows.
 */
export function BackHeading({ onBack, bar, children }: { onBack?: () => void; bar: CSSProperties; children: ReactNode }) {
  const { t } = useTranslation();
  if (!onBack) return <>{children}</>;
  return (
    <div style={{ ...bar, display: "flex", alignItems: "center", gap: 2, padding: "0 8px 0 2px" }}>
      <IconButton icon="arrow-left" label={t("common.back")} onClick={onBack} style={{ width: 44, height: 44, flex: "none" }} />
      <div style={{ flex: 1, minWidth: 0, display: "flex" }}>{children}</div>
    </div>
  );
}
