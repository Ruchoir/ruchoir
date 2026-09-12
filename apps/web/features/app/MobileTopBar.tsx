"use client";

import type { CSSProperties } from "react";
import { Avatar, IconButton } from "@/components/ds";
import { useTranslation } from "@/lib/i18n";

const bar: CSSProperties = {
  height: "var(--topbar-height)",
  flex: "none",
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "0 6px",
  borderBottom: "1px solid var(--border-subtle)",
  background: "var(--surface-chrome)",
};

/** Comfortable 44px hit area for the primary top-bar actions on touch. */
const tapTarget: CSSProperties = { width: 44, height: 44 };

const title: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontFamily: "var(--font-sans)",
  fontSize: 16,
  fontWeight: 600,
  letterSpacing: "var(--tracking-tight)",
  color: "var(--text-strong)",
};

/**
 * Top bar for the compact shell. Shows a back arrow when a conversation/view is open, otherwise the
 * workspace mark that opens the workspace rail drawer, plus search and compose actions.
 */
export function MobileTopBar({
  title: text,
  workspaceName,
  workspaceIcon,
  onBack,
  onOpenRail,
  onSearch,
  onCompose,
}: {
  title: string;
  workspaceName: string;
  /** The space's uploaded icon; absent falls back to the generated mark. */
  workspaceIcon?: string;
  onBack?: () => void;
  onOpenRail: () => void;
  onSearch: () => void;
  onCompose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div style={bar}>
      {onBack ? (
        <IconButton icon="arrow-left" label={t("common.back")} onClick={onBack} style={tapTarget} />
      ) : (
        <button
          type="button"
          onClick={onOpenRail}
          aria-label={t("shell.workspaces")}
          style={{ border: 0, background: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", ...tapTarget }}
        >
          <Avatar name={workspaceName} src={workspaceIcon} kind="workspace" size={26} shape="square" />
        </button>
      )}
      <span style={title}>{text}</span>
      <IconButton icon="search" label={t("common.search")} onClick={onSearch} style={tapTarget} />
      <IconButton icon="square-pen" label={t("shell.newMessage")} onClick={onCompose} style={tapTarget} />
    </div>
  );
}
