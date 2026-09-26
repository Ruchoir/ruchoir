"use client";

import { createContext, type CSSProperties, type ReactNode, useContext } from "react";
import { IconButton } from "@/components/ds";
import { useTranslation } from "@/lib/i18n";

/**
 * Whether the side panels are drawn as pages (a phone: the panel is the whole screen, pushed over
 * the conversation) rather than beside or over it. Set by the conversation's dock, read by every
 * panel's head, so the four panels need not each be told.
 */
export const PanelAsPage = createContext(false);

const head: CSSProperties = {
  height: "var(--topbar-height)",
  flex: "none",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 6,
  padding: "0 8px 0 16px",
  borderBottom: "1.5px solid var(--border-subtle)",
};

const titleStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: "var(--text-base)",
  fontWeight: 700,
  letterSpacing: "var(--tracking-tight)",
  color: "var(--text-strong)",
};

/**
 * A side panel's head: its title and the way out of it. Beside the conversation that is a cross at
 * the end; as a page it is an arrow at the start, where a phone's way back always is.
 */
export function PanelHead({ title, closeLabel, onClose, children }: { title: ReactNode; closeLabel: string; onClose: () => void; children?: ReactNode }) {
  const { t } = useTranslation();
  const page = useContext(PanelAsPage);
  if (page) {
    return (
      <div style={{ ...head, justifyContent: "flex-start", padding: "0 8px 0 2px" }}>
        <IconButton icon="arrow-left" label={t("common.back")} onClick={onClose} style={{ width: 44, height: 44 }} />
        <span style={titleStyle}>{title}</span>
        {children}
      </div>
    );
  }
  return (
    <div style={head}>
      <span style={titleStyle}>{title}</span>
      {children}
      <IconButton icon="x" label={closeLabel} size="sm" onClick={onClose} />
    </div>
  );
}
