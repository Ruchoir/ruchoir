/**
 * The emoji both apps offer: the categories, the quick reactions, and a search by keyword in the
 * reader's language. Reachable as `@ruchoir/client/emoji`; the dataset is large, so it stays out of
 * the package's main entry and loads only where a picker needs it.
 */

import { EMOJI_CATEGORIES, QUICK_REACTIONS } from "./data.ts";
import { keywordsMatch, normalizeSearch } from "./keywords/index.ts";

export { EMOJI_CATEGORIES, QUICK_REACTIONS, type EmojiCategory } from "./data.ts";
export { normalizeSearch } from "./keywords/index.ts";

/**
 * The quick reactions as offered: the ones used last first, then the usual ones, each once, as many
 * as `count` (the usual row's length by default).
 */
export function quickReactions(recent: readonly string[], count: number = QUICK_REACTIONS.length): string[] {
  const out: string[] = [];
  for (const emoji of [...recent, ...QUICK_REACTIONS]) {
    if (out.length >= count) break;
    if (emoji && !out.includes(emoji)) out.push(emoji);
  }
  return out;
}

/**
 * Every emoji whose keywords hold `query`, in the reader's language and then in French and English,
 * or which is the query itself; in category order, each once. An empty query finds nothing.
 */
export function searchEmojis(query: string, locale: string): string[] {
  const typed = query.trim();
  const q = normalizeSearch(typed);
  if (!q) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const category of EMOJI_CATEGORIES) {
    for (const emoji of category.emojis) {
      if (seen.has(emoji)) continue;
      if (emoji === typed || keywordsMatch(emoji, q, locale)) {
        seen.add(emoji);
        out.push(emoji);
      }
    }
  }
  return out;
}
