import type { CSSProperties } from "react";

/**
 * Styles shared by the authentication screens (sign-in, sign-up, second factor, password reset,
 * email verification), so every card in the flow carries the same heading, form and message
 * treatment. Screen-specific rules stay local to their screen.
 */
export const authStyles: Record<string, CSSProperties> = {
  title: {
    margin: 0,
    fontSize: 20,
    fontWeight: 600,
    letterSpacing: "var(--tracking-tight)",
    color: "var(--text-strong)",
  },
  subtitle: { fontSize: 13, color: "var(--text-muted)", marginTop: 4, marginBottom: 20 },
  fields: { display: "flex", flexDirection: "column", gap: 14 },
  /** Failure block under a form: bad credentials, an expired link, a rejected password. */
  error: {
    fontSize: 13,
    color: "var(--text-danger, var(--terracotta-700))",
    background: "var(--surface-danger-soft, rgba(198,93,69,0.08))",
    border: "1px solid var(--terracotta-300, rgba(198,93,69,0.3))",
    borderRadius: "var(--radius-md)",
    padding: "8px 12px",
  },
  /** Neutral confirmation block: "check your inbox", "the link was sent again". */
  notice: {
    fontSize: 13,
    color: "var(--text-default)",
    background: "var(--surface-sunken)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-md)",
    padding: "10px 12px",
  },
  /** Inline text link inside a card body or its footer. */
  link: { color: "var(--text-accent)", fontWeight: 500 },
  /** Centered icon + text layout for the outcome screens (verified, link sent). */
  outcome: { display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 12 },
  outcomeBadge: {
    width: 52,
    height: 52,
    borderRadius: "var(--radius-full)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
};
