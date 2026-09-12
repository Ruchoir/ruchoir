"use client";

/**
 * The translation runtime.
 *
 * i18next, chosen over the alternatives for a reason that is not only technical: it is developed in
 * Europe (locize, Germany and Switzerland), where FormatJS/react-intl is US-governed. Both are MIT
 * and both run at build and in the reader's browser rather than as a service, but between two
 * equivalent libraries the sovereign choice is the one that costs nothing here.
 *
 * No language detector plugin and no HTTP backend: the six dictionaries are bundled (they are small,
 * and a self-hosted instance must not fetch its own interface twice), and where the language comes
 * from is a decision this application already knows how to make, from the preferences and then from
 * the browser. One dependency doing one thing.
 */

import i18next from "i18next";
import { initReactI18next } from "react-i18next";

import de from "./dictionaries/de.json";
import en from "./dictionaries/en.json";
import es from "./dictionaries/es.json";
import fr from "./dictionaries/fr.json";
import it from "./dictionaries/it.json";
import pl from "./dictionaries/pl.json";
import { DEFAULT_LOCALE, isLocale, matchBrowserLocale, type Locale } from "./config";

/**
 * The shape every dictionary fills, taken from the French one rather than declared twice.
 *
 * French is the source language, so its file *is* the contract: a key added there fails the build
 * of the other five until they carry it, and a key invented in one of them is refused for not being
 * in the contract. That is the same guarantee the public site gets from a hand-written type, at no
 * maintenance cost.
 */
export type Dictionary = typeof fr;

const resources: Record<Locale, { translation: Dictionary }> = {
  fr: { translation: fr },
  en: { translation: en as Dictionary },
  es: { translation: es as Dictionary },
  de: { translation: de as Dictionary },
  it: { translation: it as Dictionary },
  pl: { translation: pl as Dictionary },
};

/**
 * The language to start in, before any preference has been read.
 *
 * Called during the first client render, so it must never touch the DOM in a way the static export
 * cannot reproduce: it reads the stored preference, then the browser's languages, then falls back to
 * the source language.
 */
export function initialLocale(): Locale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  try {
    const stored = JSON.parse(localStorage.getItem("ruchoir.settings") ?? "{}").locale;
    if (isLocale(stored)) return stored;
  } catch {
    // Unreadable storage is not a reason to refuse a language.
  }
  return matchBrowserLocale(navigator.languages ?? [navigator.language]) ?? DEFAULT_LOCALE;
}

let started = false;

/** Start i18next once, in the given language. Safe to call from every render. */
export function startI18n(locale: Locale = DEFAULT_LOCALE): typeof i18next {
  if (!started) {
    started = true;
    void i18next.use(initReactI18next).init({
      resources,
      lng: locale,
      fallbackLng: DEFAULT_LOCALE,
      // Keys are paths (`auth.login.title`), so the separators stay at their defaults; what changes
      // is interpolation, which must not escape: React escapes what it renders, and doing it twice
      // turns an apostrophe into `&#39;` on screen.
      interpolation: { escapeValue: false },
      returnNull: false,
    });
  } else if (i18next.language !== locale) {
    void i18next.changeLanguage(locale);
  }
  return i18next;
}

/**
 * Started at import, in the source language, before anything renders.
 *
 * Not in the person's language: the static export is prerendered in French, so a first client
 * render in Polish would not match the HTML it is hydrating, and React would discard it. The
 * settings provider switches the language in an effect, which runs after hydration. The window
 * between the two is the boot screen.
 */
startI18n(DEFAULT_LOCALE);

export { useTranslation } from "react-i18next";
export type { Locale } from "./config";
