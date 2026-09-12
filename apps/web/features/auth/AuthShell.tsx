"use client";

import { type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "@/lib/i18n";

const styles: Record<string, CSSProperties> = {
  root: {
    flex: 1,
    minHeight: "100%",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 20,
    padding: "40px 24px",
    background: "var(--surface-sunken)",
  },
  brand: { display: "flex", flexDirection: "column", alignItems: "center", gap: 8 },
  mark: { width: 48, height: 48, display: "block" },
  wordmark: {
    fontSize: 24,
    fontWeight: 600,
    letterSpacing: "-0.03em",
    color: "var(--text-strong)",
  },
  tagline: { fontSize: 13, color: "var(--text-muted)" },
  card: {
    width: "min(400px, 100%)",
    background: "var(--surface-canvas)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-lg)",
    boxShadow: "var(--shadow-dialog)",
    padding: "28px 28px 24px",
  },
  footer: { fontSize: 12, color: "var(--text-subtle)", textAlign: "center" },
};

/** Shared centered layout for the sign-in and sign-up screens: wordmark, a card, and a footer note. */
export function AuthShell({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div style={styles.root}>
      <div style={styles.brand}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/ruchoir-mark.png" alt="" style={styles.mark} />
        <div style={styles.wordmark}>
          Ruchoir<span style={{ color: "var(--terracotta-500)" }}>.</span>
        </div>
        <div style={styles.tagline}>{t("brand.tagline")}</div>
      </div>
      <main style={styles.card}>{children}</main>
      {footer ? <div style={styles.footer}>{footer}</div> : null}
    </div>
  );
}
