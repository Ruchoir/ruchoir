"use client";

import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { DEFAULT_NOTIF_PREFS, type NotifPrefs } from "./notifications";
import { isLocale, type Locale } from "@/lib/i18n/config";
import { initialLocale, startI18n } from "@/lib/i18n";
import { setCurrentLocale } from "@/lib/i18n/current";
import { DEFAULT_BINDINGS, mergeBindings, type Bindings } from "./shortcuts";

/** The four shipped themes. RuchUI (warm cream + terracotta) is the default. */
export type ThemeName = "ruchui" | "light" | "ruchui-dark" | "dark";

export const THEMES: ThemeName[] = ["ruchui", "light", "ruchui-dark", "dark"];

function isTheme(value: unknown): value is ThemeName {
  return typeof value === "string" && (THEMES as string[]).includes(value);
}

/** Interface typeface: the default IBM Plex, the OS system stack, or the dyslexia-friendly OpenDyslexic. */
export type FontChoice = "plex" | "system" | "dyslexic";
export const FONTS: FontChoice[] = ["plex", "system", "dyslexic"];
function isFont(value: unknown): value is FontChoice {
  return typeof value === "string" && (FONTS as string[]).includes(value);
}

/** First-run "getting started" checklist: whether it is dismissed and which steps are done. */
export type WelcomeState = { dismissed: boolean; done: string[] };
export const DEFAULT_WELCOME: WelcomeState = { dismissed: false, done: [] };

/** How the Files screen lists a folder. */
export type FilesLayout = "list" | "grid";
export const FILES_LAYOUTS: FilesLayout[] = ["list", "grid"];
function isFilesLayout(value: unknown): value is FilesLayout {
  return value === "list" || value === "grid";
}

/**
 * Which side panel a conversation opens with, or `none` to open with none.
 *
 * Stored as a string rather than reusing `ChannelPanel` (which uses `null` for "closed") because a
 * setting has to round-trip through JSON, where `null` and "absent" are the same thing.
 */
export type DefaultPanel = "members" | "files" | "pinned" | "none";
export const DEFAULT_PANELS: DefaultPanel[] = ["members", "files", "pinned", "none"];
function isDefaultPanel(value: unknown): value is DefaultPanel {
  return typeof value === "string" && (DEFAULT_PANELS as string[]).includes(value);
}

/** Text size, applied as a proportional zoom on the whole interface. */
export type TextSize = "s" | "m" | "l" | "xl";
export const TEXT_SIZES: TextSize[] = ["s", "m", "l", "xl"];
function isTextSize(value: unknown): value is TextSize {
  return typeof value === "string" && (TEXT_SIZES as string[]).includes(value);
}

export type Settings = {
  /** Active colour theme, applied as data-theme on <html>. Default RuchUI. */
  theme: ThemeName;
  /** Interface typeface, applied as data-font on <html>. Default IBM Plex. */
  font: FontChoice;
  /** Text size, applied as data-text on <html> (proportional interface zoom). Default medium. */
  textSize: TextSize;
  /** How the Files screen opens: as a table or as cards. Default table. */
  filesLayout: FilesLayout;
  /**
   * Which side panel a conversation opens with. Default the member list, which is what the shell
   * opened with before this was configurable.
   */
  defaultPanel: DefaultPanel;
  /** Whether Fluent emoji should animate (when the pack is available). Default on. */
  emojiAnimated: boolean;
  /**
   * Whether the self-hosted Fluent emoji pack is available. In a real deployment this comes from the
   * server (the operator may or may not install the pack); here it is a simulation so the native
   * fallback can be demonstrated. When false, emoji render with the OS-native glyphs.
   */
  emojiPack: boolean;
  /** Global notification preferences (master switch, sound, quiet hours, @channel). */
  notif: NotifPrefs;
  /** Personal account security (two-factor, passkeys, recovery codes). */
  /** Customizable keyboard shortcut bindings, keyed by command id. */
  shortcuts: Bindings;
  /** First-run getting-started checklist state. */
  welcome: WelcomeState;
  /**
   * The interface language.
   *
   * `null` means "whatever the browser asks for", which is what a fresh account gets: guessing is
   * right until someone says otherwise, and a stored value is a choice that must then be honoured
   * on a borrowed machine too.
   */
  locale: Locale | null;
};

type SettingsContextValue = Settings & {
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
};

const DEFAULTS: Settings = {
  theme: "ruchui",
  font: "plex",
  textSize: "m",
  filesLayout: "list",
  defaultPanel: "members",
  emojiAnimated: true,
  emojiPack: true,
  notif: DEFAULT_NOTIF_PREFS,
  shortcuts: DEFAULT_BINDINGS,
  welcome: DEFAULT_WELCOME,
  locale: null,
};

const SettingsContext = createContext<SettingsContextValue>({
  ...DEFAULTS,
  set: () => {},
});

const STORAGE_KEY = "ruchoir.settings";

/** Read the theme the pre-paint script (see layout.tsx) already applied, so the first render matches. */
function initialTheme(): ThemeName {
  if (typeof document !== "undefined") {
    const t = document.documentElement.dataset.theme;
    if (isTheme(t)) return t;
  }
  return DEFAULTS.theme;
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(() => ({ ...DEFAULTS, theme: initialTheme() }));

  // Load persisted settings once on mount (client only).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        // Hydration-safe: the server renders the defaults, then this reconciles from localStorage after
        // mount. Reading storage in the initializer instead would cause a hydration mismatch, so the
        // one-shot setState here is intentional.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setSettings({
          ...DEFAULTS,
          ...parsed,
          theme: isTheme(parsed.theme) ? parsed.theme : DEFAULTS.theme,
          font: isFont(parsed.font) ? parsed.font : DEFAULTS.font,
          textSize: isTextSize(parsed.textSize) ? parsed.textSize : DEFAULTS.textSize,
          filesLayout: isFilesLayout(parsed.filesLayout) ? parsed.filesLayout : DEFAULTS.filesLayout,
          defaultPanel: isDefaultPanel(parsed.defaultPanel) ? parsed.defaultPanel : DEFAULTS.defaultPanel,
          // Deep-merge notif so a stored object missing newer keys still gets their defaults.
          notif: { ...DEFAULT_NOTIF_PREFS, ...(parsed.notif ?? {}) },
          // Keep only known commands and string bindings; unknown/missing ones fall back to default.
          shortcuts: mergeBindings(parsed.shortcuts),
          locale: isLocale(parsed.locale) ? parsed.locale : null,
          welcome: {
            dismissed: typeof parsed.welcome?.dismissed === "boolean" ? parsed.welcome.dismissed : false,
            done: Array.isArray(parsed.welcome?.done)
              ? parsed.welcome.done.filter((x: unknown) => typeof x === "string")
              : [],
          },
        });
      }
    } catch {
      // ignore malformed storage
    }
  }, []);

  /**
   * Keep the translation runtime and `<html lang>` on the chosen language.
   *
   * `lang` is not decoration: it tells a screen reader which voice to use, a browser which
   * dictionary to spell-check against, and CSS which hyphenation rules apply. A French interface
   * announced as English is read aloud as gibberish.
   */
  useEffect(() => {
    const locale = settings.locale ?? initialLocale();
    startI18n(locale);
    setCurrentLocale(locale);
    document.documentElement.lang = locale;
  }, [settings.locale]);

  // Reflect the active theme onto <html> so the CSS [data-theme] blocks apply.
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);

  // Reflect the active typeface and text size onto <html> so the CSS [data-font]/[data-text] blocks apply.
  useEffect(() => {
    document.documentElement.dataset.font = settings.font;
    document.documentElement.dataset.text = settings.textSize;
  }, [settings.font, settings.textSize]);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((prev) => {
      const next = { ...prev, [key]: value };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // ignore storage failures
      }
      return next;
    });
  };

  return <SettingsContext.Provider value={{ ...settings, set }}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  return useContext(SettingsContext);
}
