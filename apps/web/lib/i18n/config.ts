/**
 * The languages Ruchoir speaks, and how one is chosen.
 *
 * Six, matching the public site: French, English, Spanish, German, Italian, Polish. French is the
 * source language, which is a fact about the product rather than a default: the interface is
 * written in French first and the other five are translations of it, so `fr` is what a missing key
 * falls back to.
 *
 * The application is a single page served by the API, so a language is not a route here (that is
 * how the public site does it, and it needs URLs a search engine can index). It is a property of
 * the person: read from their preferences, and from the browser the first time.
 */

/** A language tag this application carries a full dictionary for. */
export type Locale = "fr" | "en" | "es" | "de" | "it" | "pl";

/**
 * Every locale the type allows, for validating a stored or submitted tag.
 *
 * Not what the language menu reads: that takes `AVAILABLE_LOCALES`, derived from the dictionaries
 * this build actually carries, so the menu can never offer a language whose dictionary is missing.
 * This list exists because validation runs in places that must not pull the dictionaries in (the
 * settings loader, which runs before anything renders).
 */
export const LOCALES: Locale[] = ["fr", "en", "es", "de", "it", "pl"];

/** The source language: what the interface is written in, and what an untranslated key falls back to. */
export const DEFAULT_LOCALE: Locale = "fr";

/** What each language calls itself. A language menu that named them in French would be self-defeating. */
export const LOCALE_NAMES: Record<Locale, string> = {
  fr: "Français",
  en: "English",
  es: "Español",
  de: "Deutsch",
  it: "Italiano",
  pl: "Polski",
};

/**
 * A flag per language, for the language menu.
 *
 * A flag is a country and a language is not, which is a real objection: English is not the United
 * Kingdom's, Spanish is spoken by far more people outside Spain than in it, and German is also
 * Austria's and Switzerland's. They are here because a row of flags is scanned in an instant where a
 * column of words has to be read, and because the name in its own language sits next to each one and
 * carries the actual meaning. The flag is the icon; the endonym is the label.
 *
 * Typed against `Locale`, so a seventh language cannot be added without choosing one.
 */
export const LOCALE_FLAGS: Record<Locale, string> = {
  fr: "🇫🇷",
  en: "🇬🇧",
  es: "🇪🇸",
  de: "🇩🇪",
  it: "🇮🇹",
  pl: "🇵🇱",
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as string[]).includes(value);
}

/**
 * The best supported language for a browser, or `null` when it asks for none of them.
 *
 * Matches on the primary subtag, so `de-AT` and `de-DE` both land on German: a regional variant of
 * a language we carry is still that language, and refusing it would send an Austrian to French.
 */
export function matchBrowserLocale(languages: readonly string[]): Locale | null {
  for (const tag of languages) {
    const primary = tag.toLowerCase().split("-")[0];
    if (isLocale(primary)) return primary;
  }
  return null;
}
