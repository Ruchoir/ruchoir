"use client";

import type { CSSProperties } from "react";
import { Badge, Icon } from "@/components/ds";
import { useTranslation } from "@/lib/i18n";

export type BottomTab = { id: string; label: string; icon: string; badge?: number };

const bar: CSSProperties = {
  flex: "none",
  display: "flex",
  borderTop: "1.5px solid var(--border-subtle)",
  background: "var(--surface-chrome)",
  // Clear of the home indicator on a phone that has one; a little air on one that does not.
  paddingBottom: "max(env(safe-area-inset-bottom), 6px)",
};

/** The open tab's mark: a short ink bar hanging from the top edge. */
const indicator: CSSProperties = {
  position: "absolute",
  top: 0,
  left: "28%",
  right: "28%",
  height: 3,
  borderRadius: "0 0 3px 3px",
  background: "var(--ink)",
};

function tabStyle(active: boolean): CSSProperties {
  return {
    position: "relative",
    flex: 1,
    // A thumb's target: 52px tall, the label under the icon rather than squeezed beside it.
    minHeight: 52,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
    border: 0,
    background: "none",
    cursor: "pointer",
    color: active ? "var(--ink)" : "var(--text-muted)",
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
          {active === tab.id ? <span aria-hidden style={indicator} /> : null}
          <span style={{ position: "relative", display: "flex" }}>
            <Icon name={tab.icon} size={22} />
            {tab.badge ? (
              <span style={{ position: "absolute", top: -6, left: 10 }}>
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
