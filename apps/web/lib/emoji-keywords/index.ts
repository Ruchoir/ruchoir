import { currentLocale } from "../i18n/current";
import type { Locale } from "../i18n/config";
import de from "./de.json";
import en from "./en.json";
import es from "./es.json";
import { KEYWORDS_FR } from "./fr";
import it from "./it.json";
import pl from "./pl.json";

/** Keywords per language: emoji -> the words a reader of that language can type to find it. */
const KEYWORDS: Record<Locale, Record<string, string>> = { fr: KEYWORDS_FR, en, es, de, it, pl };

/**
 * Lower case, without accents or diacritics, so "coeur" finds "cœur" and "zolw" finds "żółw" typed
 * on a keyboard that has no Polish letters. NFD takes care of accents; the few letters that do not
 * decompose (ł, ø, œ, æ, ß) are mapped by hand.
 */
export function normalizeSearch(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ł/g, "l")
    .replace(/ø/g, "o")
    .replace(/œ/g, "oe")
    .replace(/æ/g, "ae")
    .replace(/ß/g, "ss");
}

const cache = new Map<Locale, Map<string, string>>();

function normalizedKeywords(locale: Locale): Map<string, string> {
  let map = cache.get(locale);
  if (!map) {
    map = new Map(Object.entries(KEYWORDS[locale]).map(([emoji, words]) => [emoji, normalizeSearch(words)]));
    cache.set(locale, map);
  }
  return map;
}

/**
 * Whether `query` (already normalised) matches an emoji's keywords in the language in force, with
 * French and English as a fallback: a Polish reader who types "heart" or "coeur" still finds it.
 */
export function keywordsMatch(emoji: string, query: string, locale: Locale = currentLocale()): boolean {
  const languages = new Set<Locale>([locale, "fr", "en"]);
  for (const language of languages) {
    if (normalizedKeywords(language).get(emoji)?.includes(query)) return true;
  }
  return false;
}
