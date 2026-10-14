import { KEYWORDS_DE } from "./de.ts";
import { KEYWORDS_EN } from "./en.ts";
import { KEYWORDS_ES } from "./es.ts";
import { KEYWORDS_FR } from "./fr.ts";
import { KEYWORDS_IT } from "./it.ts";
import { KEYWORDS_PL } from "./pl.ts";

/** Keywords per language: emoji -> the words a reader of that language can type to find it. */
const KEYWORDS: Record<string, Record<string, string>> = {
  fr: KEYWORDS_FR,
  en: KEYWORDS_EN,
  es: KEYWORDS_ES,
  de: KEYWORDS_DE,
  it: KEYWORDS_IT,
  pl: KEYWORDS_PL,
};

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

const cache = new Map<string, Map<string, string>>();

function normalizedKeywords(locale: string): Map<string, string> {
  let map = cache.get(locale);
  if (!map) {
    const words = KEYWORDS[locale] ?? {};
    map = new Map(Object.entries(words).map(([emoji, text]) => [emoji, normalizeSearch(text)]));
    cache.set(locale, map);
  }
  return map;
}

/**
 * Whether `query` (already normalised) matches an emoji's keywords in the reader's language, with
 * French and English as a fallback: a Polish reader who types "heart" or "coeur" still finds it.
 */
export function keywordsMatch(emoji: string, query: string, locale: string): boolean {
  const languages = new Set<string>([locale, "fr", "en"]);
  for (const language of languages) {
    if (normalizedKeywords(language).get(emoji)?.includes(query)) return true;
  }
  return false;
}
