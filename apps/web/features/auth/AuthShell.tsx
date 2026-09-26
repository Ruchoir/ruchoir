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
    fontSize: "var(--text-2xl)",
    fontWeight: 600,
    letterSpacing: "-0.03em",
    color: "var(--text-strong)",
  },
  tagline: { fontSize: "var(--text-xs)", color: "var(--text-muted)" },
  card: {
    width: "min(400px, 100%)",
    background: "var(--surface-raised)",
    border: "2px solid var(--ink)",
    borderRadius: "var(--radius-lg)",
    boxShadow: "var(--shadow-dialog)",
    padding: "28px 28px 24px",
  },
  footer: { fontSize: "var(--text-2xs)", color: "var(--text-subtle)", textAlign: "center" },
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
          Ruchoir<span style={{ color: "var(--brand)" }}>.</span>
        </div>
        <div style={styles.tagline}>{t("brand.tagline")}</div>
      </div>
      <main style={styles.card}>{children}</main>
      {footer ? <div style={styles.footer}>{footer}</div> : null}
    </div>
  );
}
