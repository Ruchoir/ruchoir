"use client";

import type { CSSProperties, ReactNode } from "react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button, Field, Icon, type IconName, Input, Select, Switch } from "@/components/ds";
import { AccountSecuritySection } from "./AccountSecurity";
import { updateMyProfile } from "@/lib/data/api";
import { initialLocale, key, literal, type TranslationKey, useTranslation } from "@/lib/i18n";
import { LanguagePicker } from "./LanguagePicker";
import { Emoji } from "./Emoji";
import { DEFAULT_NOTIF_PREFS, quietHoursLabel } from "./notifications";
import {
  notificationPermission,
  playNotificationSound,
  requestNotificationPermission,
  serverNotificationPermission,
  showDesktopNotification,
  subscribeToNotificationPermission,
} from "./desktopNotifications";
import {
  useSettings,
  type DefaultPanel,
  type FilesLayout,
  type FontChoice,
  type TextSize,
  type ThemeName,
} from "./settings";
import {
  COMMANDS,
  DEFAULT_BINDINGS,
  eventToChord,
  formatChord,
  isMac,
  type ShortcutId,
} from "./shortcuts";
import type { Toast } from "./types";

export type PrefTab = "appearance" | "notifications" | "shortcuts" | "security" | "emojis";

const NAV: [PrefTab, TranslationKey, IconName][] = [
  ["appearance", key("prefs.appearance"), "layout-grid"],
  ["notifications", key("notif.title"), "bell"],
  ["shortcuts", key("prefs.shortcuts"), "keyboard"],
  ["security", key("prefs.security"), "shield"],
  ["emojis", key("prefs.emojis"), "smile"],
];


/** Representative swatches per theme, purely for the picker preview (fixed, not live tokens). */
const THEME_PREVIEWS: { id: ThemeName; label: TranslationKey; canvas: string; chrome: string; accent: string; ink: string }[] = [
  { id: "ruchui", label: literal("RuchUI"), canvas: "#f7f3ed", chrome: "#f0e8e0", accent: "#c65d45", ink: "#171716" },
  { id: "light", label: key("prefs.themeLight"), canvas: "#ffffff", chrome: "#f4f5f6", accent: "#c65d45", ink: "#17181b" },
  { id: "ruchui-dark", label: literal("RuchUI Dark"), canvas: "#143336", chrome: "#0f2629", accent: "#d07a66", ink: "#f5f3ec" },
  { id: "dark", label: key("prefs.themeDark"), canvas: "#1a1a1c", chrome: "#141416", accent: "#db9788", ink: "#f4f4f6" },
];

const st: Record<string, CSSProperties> = {
  top: {
    height: "var(--topbar-height)",
    flex: "none",
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "0 12px",
    borderBottom: "1px solid var(--border-subtle)",
  },
  mark: { width: 22, height: 22, flex: "none", display: "block" },
  wordmark: {
    fontFamily: "var(--font-sans)",
    fontSize: 16,
    fontWeight: 600,
    letterSpacing: "var(--tracking-display)",
    color: "var(--text-strong)",
  },
  divider: { width: 1, height: 20, flex: "none", background: "var(--border-subtle)", margin: "0 2px" },
  title: {
    margin: 0,
    // Grow to fill the bar and truncate, so the mark + title never push the Retour button off-screen
    // at very narrow widths (mobile + browser zoom + large text size).
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: 15,
    fontWeight: 600,
    letterSpacing: "var(--tracking-tight)",
    color: "var(--text-strong)",
  },
  // The row itself never scrolls: the sub-nav and the panel each scroll on their own, so reading a
  // long section does not carry the nav out of reach.
  body: { flex: 1, overflow: "hidden", display: "flex", minWidth: 0, minHeight: 0 },
  nav: {
    width: 200,
    flex: "none",
    padding: "16px 8px",
    borderRight: "1px solid var(--border-subtle)",
    overflowY: "auto",
  },
  /** The scrolling half. Its bottom padding is what keeps the last row off the edge of the window. */
  scroller: { flex: 1, minWidth: 0, overflowY: "auto" },
  main: { padding: "24px 28px 64px", maxWidth: 760 },
  h: { fontSize: 18, marginBottom: 4 },
  sub: { fontSize: 13, color: "var(--text-muted)", marginBottom: 20 },
  sect: {
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: "var(--tracking-caps)",
    textTransform: "uppercase",
    color: "var(--text-subtle)",
    margin: "22px 0 10px",
  },
};

function navItem(on: boolean, compact = false): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: compact ? "auto" : "100%",
    flex: "none",
    height: 30,
    padding: "0 10px",
    border: 0,
    borderRadius: "var(--radius-sm)",
    background: on ? "var(--surface-selected)" : compact ? "var(--surface-sunken)" : "transparent",
    color: on ? "var(--text-accent)" : "var(--text-body)",
    fontFamily: "var(--font-sans)",
    fontSize: 13,
    fontWeight: on ? 500 : 400,
    cursor: "pointer",
    textAlign: "left",
    whiteSpace: "nowrap",
  };
}

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  flexWrap: "wrap",
  gap: 12,
  rowGap: 8,
  padding: "12px 0",
  borderBottom: "1px solid var(--border-subtle)",
};

/** A title + description on the left, a control on the right. */
function Row({ title, desc, children }: { title: ReactNode; desc?: ReactNode; children: ReactNode }) {
  return (
    <div style={rowStyle}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-strong)" }}>{title}</div>
        {desc ? <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2, maxWidth: 460 }}>{desc}</div> : null}
      </div>
      {children}
    </div>
  );
}

/**
 * The browser's permission for system notifications, and the one place it can be asked for.
 *
 * Asking is a deliberate act here rather than something the app does on load: a page that prompts
 * the moment it opens is why people refuse notifications for good, and a refusal cannot be undone
 * from the page. Which is also why the refused state says where to go instead of offering a button
 * that would do nothing.
 *
 * The permission is read on mount rather than rendered from the start, because there is no such
 * thing during the static export's render pass and assuming one would flash the wrong state.
 */
function BrowserNotificationRow({ soundOn, onNotify }: { soundOn: boolean; onNotify?: (t: Toast) => void }) {
  const { t } = useTranslation();
  // Read as what it is: a value owned by the browser, not by React. The third argument is the
  // snapshot for the render that happens without one, which is every render of the static export.
  const permission = useSyncExternalStore(
    subscribeToNotificationPermission,
    notificationPermission,
    serverNotificationPermission,
  );

  const test = () => {
    if (soundOn) playNotificationSound();
    showDesktopNotification({
      title: "Ruchoir",
      body: t("prefs.testBody"),
      tag: "ruchoir-test",
      onClick: () => {},
      // Said out loud, because the alternative is a button that looks broken. The browser accepted
      // it; whether anything was drawn is the system's decision and it does not report back.
      onDelivered: (shown) =>
        onNotify?.(
          shown
            ? { tone: "success", title: t("prefs.shown") }
            : {
                tone: "warning",
                title: t("prefs.notShown"),
                description:
                  t("prefs.notShownDesc"),
              },
        ),
    });
  };

  const desc =
    permission === "granted"
      ? t("prefs.notifGranted")
      : permission === "denied"
        ? t("prefs.notifDenied")
        : permission === "unsupported"
          ? t("prefs.notifUnsupported")
          : t("prefs.notifDefault");

  return (
    <Row title={t("prefs.browserNotif")} desc={desc}>
      {permission === "default" ? (
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            void requestNotificationPermission();
          }}
        >
          {t("prefs.allow")}
        </Button>
      ) : permission === "granted" ? (
        <Button size="sm" onClick={test}>
          {t("prefs.test")}
        </Button>
      ) : null}
    </Row>
  );
}

/** Preview font stacks, independent of the live --font-sans so each card always shows its own type. */
const FONT_OPTIONS: { id: FontChoice; label: TranslationKey; desc: TranslationKey; stack: string }[] = [
  { id: "plex", label: literal("IBM Plex Sans"), desc: key("prefs.fontDefault"), stack: '"IBM Plex Sans", "Helvetica Neue", sans-serif' },
  { id: "system", label: key("prefs.fontSystem"), desc: key("prefs.fontSystemDesc"), stack: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  { id: "dyslexic", label: literal("OpenDyslexic"), desc: key("prefs.fontDyslexic"), stack: '"OpenDyslexic", "Comic Sans MS", sans-serif' },
];

function FontPicker({ value, onChange }: { value: FontChoice; onChange: (f: FontChoice) => void }) {
  const { t } = useTranslation();
  return (
    <div role="radiogroup" aria-label={t("prefs.font")} style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 520 }}>
      {FONT_OPTIONS.map((f) => {
        const selected = f.id === value;
        return (
          <button
            key={f.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(f.id)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 14,
              padding: "12px 14px",
              cursor: "pointer",
              textAlign: "left",
              borderRadius: "var(--radius-md)",
              background: selected ? "var(--surface-selected)" : "var(--surface-canvas)",
              border: `1px solid ${selected ? "var(--border-accent)" : "var(--border-default)"}`,
              boxShadow: selected ? "0 0 0 1px var(--border-accent)" : "none",
              transition: "border-color var(--duration-fast) var(--ease-out)",
            }}
          >
            <span aria-hidden style={{ fontFamily: f.stack, fontSize: 30, lineHeight: 1, color: "var(--text-strong)", flex: "none", width: 44, textAlign: "center" }}>
              {t("prefs.fontSampleLetters")}
            </span>
            <span style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0, flex: 1, overflowWrap: "anywhere" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text-strong)" }}>{t(f.label)}</span>
                {selected ? <span style={{ fontSize: 11, color: "var(--text-accent)" }}>{t("prefs.active")}</span> : null}
              </span>
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{t(f.desc)}</span>
              {/* Sample rendered in the target font so the choice previews before it is applied. */}
              <span style={{ fontFamily: f.stack, fontSize: 13, color: "var(--text-body)" }}>
                {t("prefs.fontSampleText")}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

const SIZE_OPTIONS: { id: TextSize; label: TranslationKey; sample: number }[] = [
  { id: "s", label: key("prefs.sizeS"), sample: 13 },
  { id: "m", label: key("prefs.sizeM"), sample: 15 },
  { id: "l", label: key("prefs.sizeL"), sample: 17 },
  { id: "xl", label: key("prefs.sizeXL"), sample: 20 },
];

function TextSizePicker({ value, onChange }: { value: TextSize; onChange: (t: TextSize) => void }) {
  const { t } = useTranslation();
  return (
    <div role="radiogroup" aria-label={t("prefs.textSize")} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {SIZE_OPTIONS.map((o) => {
        const selected = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(o.id)}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              width: 96,
              height: 72,
              cursor: "pointer",
              borderRadius: "var(--radius-md)",
              background: selected ? "var(--surface-selected)" : "var(--surface-canvas)",
              border: `1px solid ${selected ? "var(--border-accent)" : "var(--border-default)"}`,
              boxShadow: selected ? "0 0 0 1px var(--border-accent)" : "none",
              transition: "border-color var(--duration-fast) var(--ease-out)",
            }}
          >
            <span aria-hidden style={{ fontSize: o.sample, fontWeight: 600, lineHeight: 1, color: "var(--text-strong)" }}>A</span>
            <span style={{ fontSize: 12, color: selected ? "var(--text-accent)" : "var(--text-muted)" }}>{t(o.label)}</span>
          </button>
        );
      })}
    </div>
  );
}

function ThemePicker({ value, onChange }: { value: ThemeName; onChange: (t: ThemeName) => void }) {
  const { t } = useTranslation();
  return (
    <div role="radiogroup" aria-label={t("prefs.theme")} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, maxWidth: 520 }}>
      {THEME_PREVIEWS.map((theme) => {
        const selected = theme.id === value;
        return (
          <button
            key={theme.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(theme.id)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: 8,
              cursor: "pointer",
              textAlign: "left",
              borderRadius: "var(--radius-md)",
              background: selected ? "var(--surface-selected)" : "var(--surface-canvas)",
              border: `1px solid ${selected ? "var(--border-accent)" : "var(--border-default)"}`,
              boxShadow: selected ? "0 0 0 1px var(--border-accent)" : "none",
              transition: "border-color var(--duration-fast) var(--ease-out)",
            }}
          >
            {/* Miniature UI: chrome strip + canvas with an accent dot and text bars. */}
            <span
              aria-hidden
              style={{
                display: "flex",
                width: 46,
                height: 34,
                flex: "none",
                borderRadius: "var(--radius-sm)",
                overflow: "hidden",
                border: "1px solid var(--border-subtle)",
                background: theme.canvas,
              }}
            >
              <span style={{ width: 12, height: "100%", background: theme.chrome }} />
              <span style={{ flex: 1, position: "relative", padding: 5 }}>
                <span style={{ display: "block", width: 8, height: 8, borderRadius: "var(--radius-full)", background: theme.accent }} />
                <span style={{ display: "block", width: "80%", height: 3, marginTop: 4, borderRadius: 2, background: theme.ink, opacity: 0.55 }} />
                <span style={{ display: "block", width: "55%", height: 3, marginTop: 3, borderRadius: 2, background: theme.ink, opacity: 0.3 }} />
              </span>
            </span>
            <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
              <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text-strong)" }}>{t(theme.label)}</span>
              {selected ? <span style={{ fontSize: 11, color: "var(--text-accent)" }}>{t("prefs.active")}</span> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

const kbdStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  color: "var(--text-muted)",
  background: "var(--grey-100)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius-sm)",
  padding: "2px 8px",
  whiteSpace: "nowrap",
};

/** One editable shortcut row: label + hint on the left, current chord and controls on the right. */
function ShortcutRow({
  id,
  capturing,
  chord,
  isDefault,
  conflict,
  mac,
  onStart,
  onReset,
}: {
  id: ShortcutId;
  capturing: boolean;
  chord: string;
  isDefault: boolean;
  conflict: TranslationKey | null;
  mac: boolean;
  onStart: () => void;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  const def = COMMANDS.find((c) => c.id === id)!;
  return (
    <div style={rowStyle}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-strong)" }}>{t(def.label)}</div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2, maxWidth: 460 }}>{t(def.hint)}</div>
        {conflict ? (
          <div style={{ fontSize: 12, color: "var(--status-danger-fg)", marginTop: 4 }}>
            {t("shortcut.conflict", { label: t(conflict) })}
          </div>
        ) : null}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        {capturing ? (
          <span
            style={{
              ...kbdStyle,
              color: "var(--text-accent)",
              borderColor: "var(--border-accent)",
              background: "var(--surface-selected)",
            }}
          >
            {t("shortcut.pressCombination")}
          </span>
        ) : chord ? (
          <kbd style={kbdStyle}>{formatChord(chord, mac, t)}</kbd>
        ) : (
          <span style={{ fontSize: 12, color: "var(--text-subtle)" }}>{t("dialogs.unassigned")}</span>
        )}
        <Button size="sm" variant="secondary" onClick={onStart} aria-label={t("shortcut.editShortcut", { label: t(def.label) })}>
          {capturing ? t("common.cancel") : t("message.edit")}
        </Button>
        {!isDefault ? (
          <Button
            size="sm"
            variant="ghost"
            iconLeft="refresh-cw"
            onClick={onReset}
            aria-label={t("shortcut.resetShortcut", { label: t(def.label) })}
          />
        ) : null}
      </div>
    </div>
  );
}

/** The "Raccourcis clavier" preferences panel: view, rebind, unbind and reset each command. */
function ShortcutsSection({ onNotify }: { onNotify?: (t: Toast) => void }) {
  const { t } = useTranslation();
  const s = useSettings();
  const bindings = s.shortcuts;
  const [capturing, setCapturing] = useState<ShortcutId | null>(null);
  const mac = isMac();

  // Latest-value refs so the capture listener (attached once per capture) always sees fresh state.
  const bindingsRef = useRef(bindings);
  const setRef = useRef(s.set);
  useEffect(() => {
    bindingsRef.current = bindings;
    setRef.current = s.set;
  });

  // While capturing, the next chord replaces the binding. Escape cancels, Backspace/Delete unbinds.
  // A capture-phase listener runs before the preferences' own Escape handler, so cancelling never
  // closes the whole screen.
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setCapturing(null);
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        setRef.current("shortcuts", { ...bindingsRef.current, [capturing]: "" });
        setCapturing(null);
        return;
      }
      const chord = eventToChord(e);
      if (!chord) return; // lone modifier: keep waiting for the full combination
      setRef.current("shortcuts", { ...bindingsRef.current, [capturing]: chord });
      setCapturing(null);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [capturing]);

  // Map each chord to the commands that use it, to flag duplicates.
  const usedBy: Record<string, ShortcutId[]> = {};
  for (const c of COMMANDS) {
    const ch = bindings[c.id];
    if (ch) (usedBy[ch] ??= []).push(c.id);
  }
  const conflictLabel = (id: ShortcutId): TranslationKey | null => {
    const ch = bindings[id];
    if (!ch) return null;
    const other = (usedBy[ch] ?? []).find((x) => x !== id);
    return other ? COMMANDS.find((c) => c.id === other)!.label : null;
  };

  const resetAll = () => {
    setRef.current("shortcuts", { ...DEFAULT_BINDINGS });
    setCapturing(null);
    onNotify?.({ tone: "info", title: t("prefs.shortcutsReset") });
  };

  return (
    <>
      <h2 style={st.h}>{t("prefs.shortcuts")}</h2>
      <p style={st.sub}>
        {t("shortcut.customizeHint")}
      </p>
      {COMMANDS.map((c) => (
        <ShortcutRow
          key={c.id}
          id={c.id}
          capturing={capturing === c.id}
          chord={bindings[c.id]}
          isDefault={bindings[c.id] === c.defaultChord}
          conflict={conflictLabel(c.id)}
          mac={mac}
          onStart={() => setCapturing((prev) => (prev === c.id ? null : c.id))}
          onReset={() => s.set("shortcuts", { ...bindings, [c.id]: c.defaultChord })}
        />
      ))}
      <div style={{ marginTop: 18 }}>
        <Button variant="secondary" iconLeft="refresh-cw" onClick={resetAll}>
          {t("shortcut.resetAll")}
        </Button>
      </div>
    </>
  );
}

export type PreferencesScreenProps = {
  onClose: () => void;
  onNotify?: (t: Toast) => void;
  /** Every session was just ended: the app returns to the sign-in screen. */
  onSignedOut?: () => void;
  /** Compact (mobile): stack the sub-nav above the panel. */
  compact?: boolean;
  /** Section to open on mount (defaults to appearance). */
  initialTab?: PrefTab;
};

/** Full-screen personal preferences view: appearance, notifications, account security and emojis. */
export function PreferencesScreen({
  onClose,
  onNotify,
  onSignedOut,
  compact = false,
  initialTab = "appearance",
}: PreferencesScreenProps) {
  const s = useSettings();
  const { t } = useTranslation();
  const [tab, setTab] = useState<PrefTab>(initialTab);

  // Escape leaves the preferences, but only when no sub-dialog is open (a dialog handles Escape first).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (document.querySelector('[role="dialog"]')) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
      <div style={st.top}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/ruchoir-mark.png" alt="" style={st.mark} />
        {compact ? null : <span style={st.wordmark}>Ruchoir</span>}
        <span style={st.divider} aria-hidden />
        <h1 style={st.title}>{t("prefs.title")}</h1>
        <Button variant="secondary" iconLeft="arrow-left" onClick={onClose} style={{ flexShrink: 0 }}>
          {compact ? t("common.back") : t("prefs.backToSpace")}
        </Button>
      </div>
      <div style={compact ? { ...st.body, flexDirection: "column" } : st.body}>
        <div
          style={
            compact
              ? { flex: "none", display: "flex", flexWrap: "wrap", gap: 6, padding: "8px 12px", borderBottom: "1px solid var(--border-subtle)" }
              : st.nav
          }
        >
          {NAV.map(([v, l, i]) => (
            <button key={v} style={navItem(v === tab, compact)} onClick={() => setTab(v)}>
              <Icon name={i} size={14} style={{ color: "var(--text-muted)" }} />
              {t(l)}
            </button>
          ))}
        </div>

        <div style={st.scroller}>
          <div style={compact ? { ...st.main, padding: "16px 16px 48px" } : st.main}>
            {tab === "appearance" ? (
              <>
                <h2 style={st.h}>{t("prefs.appearance")}</h2>
                <p style={st.sub}>{t("prefs.appearanceSub")}</p>

                <div style={st.sect}>{t("language.section")}</div>
                {/*
                  Under its description rather than beside it: the control is wide (a flag, a
                  language named in its own script, a chevron), and squeezed into the right-hand
                  column of a Row it fought the sentence explaining it for the same inches.
                */}
                <div style={{ marginBottom: 4 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-strong)" }}>
                    {t("language.title")}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", margin: "2px 0 10px", maxWidth: 520 }}>
                    {t("language.description")}
                  </div>
                  <LanguagePicker
                    value={s.locale}
                    onChange={(next) => {
                      s.set("locale", next);
                      // Told to the server too, because the server writes: confirmations, password
                      // resets and invitations are the half of the product a browser preference
                      // cannot reach. A blank clears it back to following the browser.
                      // Back to "follow the browser" still means reading in a language: the account
                      // records the one now in force, not a blank, or the profile would go quiet
                      // about something that is plainly true.
                      void updateMyProfile({ locale: next ?? initialLocale() }).catch(() => {
                        // A language that did not reach the account still applies to the interface;
                        // it is not worth an error in the middle of a preferences screen.
                      });
                    }}
                  />
                </div>

                <div style={st.sect}>{t("prefs.theme")}</div>
                <ThemePicker value={s.theme} onChange={(t) => s.set("theme", t)} />
                <div style={st.sect}>{t("prefs.font")}</div>
                <FontPicker value={s.font} onChange={(f) => s.set("font", f)} />
                <div style={st.sect}>{t("prefs.textSize")}</div>
                <TextSizePicker value={s.textSize} onChange={(t) => s.set("textSize", t)} />

                <div style={st.sect}>{t("prefs.defaultDisplay")}</div>
                <Row title={t("prefs.filesView")} desc={t("prefs.filesViewDesc")}>
                  <Select
                    aria-label={t("prefs.filesViewLabel")}
                    value={s.filesLayout}
                    onChange={(e) => s.set("filesLayout", e.target.value as FilesLayout)}
                    options={[
                      { value: "list", label: t("prefs.table") },
                      { value: "grid", label: t("prefs.cards") },
                    ]}
                  />
                </Row>
                <Row
                  title={t("prefs.rightPanel")}
                  desc={t("prefs.rightPanelDesc")}
                >
                  <Select
                    aria-label={t("prefs.rightPanelLabel")}
                    value={s.defaultPanel}
                    onChange={(e) => s.set("defaultPanel", e.target.value as DefaultPanel)}
                    options={[
                      { value: "members", label: t("conversation.members") },
                      { value: "files", label: t("gsearch.files") },
                      { value: "pinned", label: t("prefs.pinnedShort") },
                      { value: "none", label: t("prefs.none") },
                    ]}
                  />
                </Row>
              </>
            ) : null}

            {tab === "notifications" ? (
              <>
                <h2 style={st.h}>{t("notif.title")}</h2>
                <p style={st.sub}>{t("prefs.notifSub")}</p>
                <BrowserNotificationRow soundOn={s.notif.sound} onNotify={onNotify} />
                <Row title={t("prefs.enableNotif")} desc={t("prefs.enableNotifDesc")}>
                  <Switch checked={s.notif.enabled} onChange={(e) => s.set("notif", { ...s.notif, enabled: e.target.checked })} aria-label={t("prefs.enableNotif")} />
                </Row>
                <Row title={t("prefs.notifSound")} desc={t("prefs.notifSoundDesc")}>
                  <Switch checked={s.notif.sound} onChange={(e) => s.set("notif", { ...s.notif, sound: e.target.checked })} aria-label={t("prefs.notifSound")} />
                </Row>
                <Row title={t("prefs.channelMentions")} desc={t("prefs.channelMentionsDesc")}>
                  <Switch checked={s.notif.channelMentions} onChange={(e) => s.set("notif", { ...s.notif, channelMentions: e.target.checked })} aria-label={t("prefs.channelMentions")} />
                </Row>
                <Row
                  title={t("prefs.quietHours")}
                  desc={
                    s.notif.quietHours
                      ? t("prefs.quietHoursActive", { window: quietHoursLabel(s.notif) })
                      : t("prefs.quietHoursDesc")
                  }
                >
                  <Switch checked={s.notif.quietHours} onChange={(e) => s.set("notif", { ...s.notif, quietHours: e.target.checked })} aria-label={t("prefs.quietHours")} />
                </Row>
                {s.notif.quietHours ? (
                  <div style={{ display: "flex", gap: 12, padding: "16px 0 4px" }}>
                    <Field label={t("prefs.from")} htmlFor="quiet-from">
                      <Input id="quiet-from" type="time" size="sm" value={s.notif.quietFrom ?? DEFAULT_NOTIF_PREFS.quietFrom} onChange={(e) => s.set("notif", { ...s.notif, quietFrom: e.target.value })} />
                    </Field>
                    <Field label={t("prefs.to")} htmlFor="quiet-to">
                      <Input id="quiet-to" type="time" size="sm" value={s.notif.quietTo ?? DEFAULT_NOTIF_PREFS.quietTo} onChange={(e) => s.set("notif", { ...s.notif, quietTo: e.target.value })} />
                    </Field>
                  </div>
                ) : null}
              </>
            ) : null}

            {tab === "shortcuts" ? <ShortcutsSection onNotify={onNotify} /> : null}

            {tab === "security" ? (
              <>
                <h2 style={st.h}>{t("prefs.security")}</h2>
                <p style={st.sub}>{t("prefs.securitySub")}</p>
                <AccountSecuritySection onNotify={onNotify} onSignedOut={onSignedOut} />
              </>
            ) : null}

            {tab === "emojis" ? (
              <>
                <h2 style={st.h}>{t("prefs.emojis")}</h2>
                <p style={st.sub}>{t("prefs.emojisSub")}</p>
                <Row
                  title={
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      {t("prefs.animatedEmoji")} <Emoji emoji="🎉" size={18} />
                    </span>
                  }
                  desc={t("prefs.animatedEmojiDesc")}
                >
                  <Switch checked={s.emojiAnimated} onChange={(e) => s.set("emojiAnimated", e.target.checked)} aria-label={t("prefs.animatedEmoji")} />
                </Row>
                {/* Dev-only: simulates the operator NOT installing the pack, to demo the native fallback.
                    In production the pack presence comes from the server, so this toggle has no place there. */}
                {process.env.NODE_ENV !== "production" ? (
                  <Row title={t("prefs.emojiPack")} desc={t("prefs.emojiPackDesc")}>
                    <Switch checked={s.emojiPack} onChange={(e) => s.set("emojiPack", e.target.checked)} aria-label={t("prefs.emojiPack")} />
                  </Row>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
