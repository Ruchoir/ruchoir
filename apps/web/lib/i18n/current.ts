/**
 * The language in force, readable outside React.
 *
 * The data layer is not a component and has no hook, but it does send the language to the server
 * (at registration, and whenever it changes). Rather than thread a locale through every call site,
 * it asks here, and the settings provider keeps this in step with what the interface is showing.
 */

import { DEFAULT_LOCALE, isLocale, type Locale } from "./config";

let current: Locale = DEFAULT_LOCALE;

export function setCurrentLocale(locale: Locale): void {
  current = locale;
}

export function currentLocale(): Locale {
  return current;
}

/** Reads the tag a browser gives us, for the rare caller that has one in hand. */
export function asLocale(value: unknown): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}
