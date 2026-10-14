import type { Locale } from ".";

/**
 * What each language calls itself, as the web's menu names them (`apps/web/lib/i18n/config.ts`): a
 * language list that named them in French would be self-defeating.
 */
export const LANGUAGE_NAMES: Record<Locale, string> = {
  // i18n-audit-ignore-next-line -- a language's own name, by definition not translated
  fr: "Français",
  // i18n-audit-ignore-next-line -- a language's own name, by definition not translated
  en: "English",
  // i18n-audit-ignore-next-line -- a language's own name, by definition not translated
  es: "Español",
  // i18n-audit-ignore-next-line -- a language's own name, by definition not translated
  de: "Deutsch",
  // i18n-audit-ignore-next-line -- a language's own name, by definition not translated
  it: "Italiano",
  // i18n-audit-ignore-next-line -- a language's own name, by definition not translated
  pl: "Polski",
};
