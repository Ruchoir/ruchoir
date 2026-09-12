"use client";

import { type CSSProperties, useRef, useState } from "react";
import { Flag, Icon, Popover } from "@/components/ds";
import { AVAILABLE_LOCALES, useTranslation } from "@/lib/i18n";
import { LOCALE_NAMES, type Locale } from "@/lib/i18n/config";

/**
 * The language menu.
 *
 * A native `<select>` cannot draw anything but text in its options, so a flag beside each language
 * means owning the menu. It is a button and a listbox rather than a styled `<select>`: the same
 * keyboard contract (arrows to move, Enter or Space to choose, Escape to leave), the same roles for
 * assistive technology, and room for an icon.
 *
 * Each language is named in itself. A menu that listed them in French would be unreadable to exactly
 * the person reaching for it.
 */

const st: Record<string, CSSProperties> = {
  trigger: {
    display: "inline-flex",
    alignItems: "center",
    gap: 12,
    // Wide and tall enough to be read as the main control of its row rather than as a footnote to
    // the sentence above it, and it now sits on its own line.
    minWidth: 280,
    height: 40,
    padding: "0 12px",
    background: "var(--surface-canvas)",
    border: "1px solid var(--border-default)",
    borderRadius: "var(--radius-md)",
    color: "var(--text-strong)",
    fontFamily: "var(--font-sans)",
    fontSize: 14,
    cursor: "pointer",
    textAlign: "left",
  },
  list: {
    minWidth: 280,
    padding: 4,
    background: "var(--surface-canvas)",
    border: "1px solid var(--border-default)",
    borderRadius: "var(--radius-md)",
    boxShadow: "var(--shadow-popover, var(--shadow-dialog))",
  },
  option: {
    display: "flex",
    alignItems: "center",
    // The gap between the flag and the name: the two are separate pieces of information, and set
    // tight against each other they read as one smudge at the start of the line.
    gap: 12,
    width: "100%",
    height: 36,
    padding: "0 12px",
    border: 0,
    borderRadius: "var(--radius-sm)",
    background: "transparent",
    color: "var(--text-body)",
    fontFamily: "var(--font-sans)",
    fontSize: 14,
    cursor: "pointer",
    textAlign: "left",
  },
  /**
   * The icon standing where a flag stands on the other rows: "follow the browser" is a choice about
   * the device, not about a country, and an empty gap there made the row look unfinished.
   */
  autoIcon: { width: 20, flex: "none", display: "flex", justifyContent: "center" },
};

export function LanguagePicker({
  value,
  onChange,
}: {
  /** The chosen language, or `null` to follow the browser. */
  value: Locale | null;
  onChange: (next: Locale | null) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);

  const choose = (next: Locale | null) => {
    onChange(next);
    setOpen(false);
    anchor.current?.focus();
  };

  const rows: { key: string; locale: Locale | null; label: string }[] = [
    { key: "auto", locale: null, label: t("language.automatic") },
    ...AVAILABLE_LOCALES.map((code) => ({ key: code, locale: code, label: LOCALE_NAMES[code] })),
  ];

  return (
    <>
      <button
        ref={anchor}
        type="button"
        style={st.trigger}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {value ? (
          <Flag locale={value} />
        ) : (
          <span style={st.autoIcon}>
            <Icon name="monitor" size={16} style={{ color: "var(--text-muted)" }} />
          </span>
        )}
        <span style={{ flex: 1, minWidth: 0 }}>{value ? LOCALE_NAMES[value] : t("language.automatic")}</span>
        <Icon name="chevron-down" size={14} style={{ color: "var(--text-muted)" }} />
      </button>

      <Popover anchorRef={anchor} open={open} onClose={() => setOpen(false)} placement="bottom" align="start">
        <div style={st.list} role="listbox" aria-label={t("language.title")}>
          {rows.map((row) => {
            const selected = row.locale === value;
            return (
              <button
                key={row.key}
                type="button"
                role="option"
                aria-selected={selected}
                style={{
                  ...st.option,
                  background: selected ? "var(--surface-selected)" : "transparent",
                  color: selected ? "var(--text-accent)" : "var(--text-body)",
                }}
                onClick={() => choose(row.locale)}
                onMouseEnter={(e) => {
                  if (!selected) e.currentTarget.style.background = "var(--surface-hover)";
                }}
                onMouseLeave={(e) => {
                  if (!selected) e.currentTarget.style.background = "transparent";
                }}
              >
                {row.locale ? (
                  <Flag locale={row.locale} />
                ) : (
                  <span style={st.autoIcon}>
                    <Icon name="monitor" size={16} style={{ color: "var(--text-muted)" }} />
                  </span>
                )}
                <span style={{ flex: 1, minWidth: 0 }}>{row.label}</span>
                {selected ? <Icon name="check" size={14} /> : null}
              </button>
            );
          })}
        </div>
      </Popover>
    </>
  );
}
