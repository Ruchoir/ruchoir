"use client";

import type { CSSProperties } from "react";
import { Button, Icon } from "@/components/ds";

/**
 * Offer to turn on system notifications, once, shortly after signing in.
 *
 * Notifications are on in Ruchoir's own preferences from the start; what is missing on a fresh
 * browser is the browser's permission, and only the browser can grant that. Someone who never opens
 * the preferences therefore never hears about a message while they are in another tab, and has no
 * reason to suspect it.
 *
 * It is a card with a button rather than a prompt that fires on its own, and that is not politeness:
 * **Firefox and Safari ignore a permission request that does not follow a click.** An automatic call
 * would do nothing at all on either, and on Chrome it would spend the one chance the site gets, a
 * denial being undoable only from the browser's own settings. The button is what makes the request
 * reach the browser, and what makes a refusal a refusal of something the person was asked.
 *
 * Shown once: dismissing it or answering it records the fact, so it never becomes furniture.
 */

const st: Record<string, CSSProperties> = {
  card: {
    position: "fixed",
    right: 20,
    bottom: 20,
    zIndex: 55,
    width: "min(340px, calc(var(--ui-vw, 100vw) - 32px))",
    display: "flex",
    gap: 12,
    padding: 14,
    background: "var(--surface-canvas)",
    border: "1px solid var(--border-default)",
    borderRadius: "var(--radius-lg)",
    boxShadow: "var(--shadow-dialog)",
  },
  icon: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flex: "none",
    width: 32,
    height: 32,
    borderRadius: "var(--radius-full)",
    background: "var(--surface-sunken)",
  },
  title: { fontSize: 13, fontWeight: 600, color: "var(--text-strong)" },
  body: { fontSize: 12, lineHeight: 1.5, color: "var(--text-muted)", margin: "4px 0 10px" },
  actions: { display: "flex", gap: 8 },
};

export function NotificationPrompt({
  onAllow,
  onDismiss,
  compact = false,
}: {
  /** Ask the browser. Called from the click, which is the only way the request is honoured. */
  onAllow: () => void;
  onDismiss: () => void;
  compact?: boolean;
}) {
  return (
    <div style={compact ? { ...st.card, bottom: 76 } : st.card} role="dialog" aria-label="Activer les notifications">
      <span style={st.icon}>
        <Icon name="bell" size={16} style={{ color: "var(--text-accent)" }} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={st.title}>Être prévenu hors de l&apos;onglet</div>
        <p style={st.body}>
          Sans l&apos;autorisation du navigateur, Ruchoir ne peut rien vous signaler quand vous regardez autre chose.
          Vous pourrez revenir dessus dans les préférences.
        </p>
        <div style={st.actions}>
          <Button size="sm" variant="primary" onClick={onAllow}>
            Activer
          </Button>
          <Button size="sm" onClick={onDismiss}>
            Plus tard
          </Button>
        </div>
      </div>
    </div>
  );
}
