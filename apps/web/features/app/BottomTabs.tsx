"use client";

import type { CSSProperties } from "react";
import { Badge, Icon } from "@/components/ds";
import { useTranslation } from "@/lib/i18n";

export type BottomTab = { id: string; label: string; icon: string; badge?: number };

const bar: CSSProperties = {
  flex: "none",
  display: "flex",
  borderTop: "1px solid var(--border-subtle)",
  background: "var(--surface-chrome)",
  paddingBottom: "env(safe-area-inset-bottom)",
};

function tabStyle(active: boolean): CSSProperties {
  return {
    flex: 1,
    minHeight: 52,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
    border: 0,
    background: "none",
    cursor: "pointer",
    color: active ? "var(--terracotta-600)" : "var(--text-muted)",
    fontFamily: "var(--font-sans)",
    fontSize: 11,
    fontWeight: active ? 600 : 500,
  };
}

/** Bottom navigation bar for the compact shell (mobile/narrow). Each tab is a full-height target. */
export function BottomTabs({
  tabs,
  active,
  onSelect,
}: {
  tabs: BottomTab[];
  active: string;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <nav style={bar} aria-label={t("shell.mainNav")}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          style={tabStyle(active === tab.id)}
          aria-current={active === tab.id ? "page" : undefined}
          onClick={() => onSelect(tab.id)}
        >
          <span style={{ position: "relative", display: "flex" }}>
            <Icon name={tab.icon} size={20} />
            {tab.badge ? (
              <span style={{ position: "absolute", top: -6, left: 12 }}>
                <Badge count={tab.badge} />
              </span>
            ) : null}
          </span>
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
