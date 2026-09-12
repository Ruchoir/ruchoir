"use client";

import { type CSSProperties, useState } from "react";
import { Button, Icon, type IconName, IconButton } from "@/components/ds";
import { key, type TranslationKey, useTranslation } from "@/lib/i18n";

/** A step, holding dictionary keys: the list is built at module load, before a language exists. */
export type GettingStartedStep = { id: string; icon: IconName; label: TranslationKey; desc: TranslationKey };

/** The first-run steps, in order. Ids are persisted in settings.welcome.done. */
export const GETTING_STARTED_STEPS: GettingStartedStep[] = [
  { id: "profile", icon: "smile", label: key("welcome.profile"), desc: key("welcome.profileDesc") },
  { id: "channel", icon: "hash", label: key("welcome.channel"), desc: key("welcome.channelDesc") },
  { id: "message", icon: "send", label: key("welcome.message"), desc: key("welcome.messageDesc") },
  { id: "invite", icon: "user-plus", label: key("welcome.invite"), desc: key("welcome.inviteDesc") },
  // The import step is deliberately absent until an importer exists: a first-run checklist that
  // asks for something the product cannot do is the worst place to make that promise. It comes back
  // with the first real importer, alongside the sidebar entry.
];

const st: Record<string, CSSProperties> = {
  card: {
    display: "flex",
    flexDirection: "column",
    width: "min(340px, calc(var(--ui-vw, 100vw) - 32px))",
    background: "var(--surface-canvas)",
    border: "1px solid var(--border-default)",
    borderRadius: "var(--radius-lg)",
    boxShadow: "var(--shadow-dialog)",
    overflow: "hidden",
  },
  head: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 8px 8px 14px",
  },
  headToggle: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flex: 1,
    minWidth: 0,
    padding: "4px 0",
    cursor: "pointer",
    border: 0,
    background: "transparent",
    textAlign: "left",
  },
  title: { flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, color: "var(--text-strong)" },
  count: { fontSize: 12, fontWeight: 500, color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" },
  bar: { height: 3, background: "var(--grey-200)" },
  barFill: { height: "100%", background: "var(--terracotta-500)", transition: "width var(--duration-base) var(--ease-out)" },
  list: { display: "flex", flexDirection: "column", padding: "6px 8px 10px" },
  row: {
    display: "flex",
    alignItems: "center",
    gap: 11,
    width: "100%",
    padding: "9px 8px",
    border: 0,
    borderRadius: "var(--radius-md)",
    background: "transparent",
    cursor: "pointer",
    textAlign: "left",
  },
  bullet: {
    flex: "none",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 30,
    height: 30,
    borderRadius: "var(--radius-full)",
  },
  foot: { padding: "4px 14px 14px", display: "flex", justifyContent: "flex-end" },
};

export type GettingStartedProps = {
  /** Ids of completed steps (persisted). */
  done: string[];
  /** Run the action for a step (also marks it done). */
  onRun: (id: string) => void;
  /** Dismiss the checklist for good. */
  onDismiss: () => void;
  compact?: boolean;
};

/** First-run getting-started checklist, floating bottom-right (above the bottom tabs on compact). */
export function GettingStarted({ done, onRun, onDismiss, compact = false }: GettingStartedProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const doneSet = new Set(done);
  const count = GETTING_STARTED_STEPS.filter((s) => doneSet.has(s.id)).length;
  const total = GETTING_STARTED_STEPS.length;
  const allDone = count === total;

  return (
    <div
      className="wc-fade-in"
      style={{
        position: "fixed",
        right: compact ? 12 : 20,
        bottom: compact ? 76 : 20,
        zIndex: 55,
      }}
    >
      <div style={st.card} role="region" aria-label={t("welcome.title")}>
        <div style={st.head}>
          <button type="button" style={st.headToggle} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            <span style={st.title}>{t("welcome.title")}</span>
            <span style={st.count}>
              {count}/{total}
            </span>
            <Icon
              name="chevron-down"
              size={16}
              style={{
                color: "var(--text-muted)",
                transform: open ? "none" : "rotate(180deg)",
                transition: "transform var(--duration-fast) var(--ease-out)",
              }}
            />
          </button>
          <IconButton icon="x" label={t("welcome.hide")} size="sm" onClick={onDismiss} />
        </div>

        <div style={st.bar}>
          <div style={{ ...st.barFill, width: `${(count / total) * 100}%` }} />
        </div>

        {open ? (
          <>
            <div style={st.list}>
              {GETTING_STARTED_STEPS.map((s) => {
                const isDone = doneSet.has(s.id);
                return (
                  <button
                    key={s.id}
                    type="button"
                    className="wc-listrow"
                    style={st.row}
                    onClick={() => onRun(s.id)}
                  >
                    <span
                      style={{
                        ...st.bullet,
                        background: isDone ? "var(--terracotta-500)" : "var(--surface-sunken)",
                        color: isDone ? "var(--action-primary-fg)" : "var(--text-muted)",
                      }}
                    >
                      <Icon name={isDone ? "check" : s.icon} size={16} />
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span
                        style={{
                          display: "block",
                          fontSize: 13,
                          fontWeight: 500,
                          color: isDone ? "var(--text-muted)" : "var(--text-strong)",
                        }}
                      >
                        {t(s.label)}
                      </span>
                      <span style={{ display: "block", fontSize: 12, color: "var(--text-subtle)", marginTop: 1 }}>{t(s.desc)}</span>
                    </span>
                    <Icon name="chevron-right" size={15} style={{ color: "var(--text-subtle)", flex: "none" }} />
                  </button>
                );
              })}
            </div>
            <div style={st.foot}>
              {allDone ? (
                <Button size="sm" variant="primary" onClick={onDismiss}>
                  {t("onboarding.finish")}
                </Button>
              ) : (
                <Button size="sm" variant="link" onClick={onDismiss}>
                  {t("welcome.hideForever")}
                </Button>
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
