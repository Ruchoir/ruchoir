/**
 * Emoji for the reaction picker. The dataset (categories, quick reactions, keywords in six
 * languages) is shared with the mobile app in `@ruchoir/client/emoji`; the web adds its category
 * labels and searches in the language the interface speaks.
 */

import {
  EMOJI_CATEGORIES as SHARED_CATEGORIES,
  searchEmojis as searchIn,
  type EmojiCategory as SharedCategory,
} from "@ruchoir/client/emoji";
import { key, type TranslationKey } from "@/lib/i18n";
import { currentLocale } from "@/lib/i18n/current";

export { QUICK_REACTIONS } from "@ruchoir/client/emoji";

export type EmojiCategory = SharedCategory & { label: TranslationKey };

/** Each category's name on screen, by its id. */
const LABELS: Record<string, TranslationKey> = {
  smileys: key("emoji.smileys"),
  gestures: key("emoji.gestures"),
  people: key("gsearch.people"),
  hearts: key("emoji.hearts"),
  nature: key("emoji.nature"),
  food: key("emoji.food"),
  travel: key("emoji.travel"),
  activities: key("emoji.activities"),
  objects: key("emoji.objects"),
  symbols: key("emoji.symbols"),
};

export const EMOJI_CATEGORIES: EmojiCategory[] = SHARED_CATEGORIES.map((category) => ({
  ...category,
  label: LABELS[category.id],
}));

/** Flat search over every category by keyword (in the language in force, then French and English) or the emoji itself. */
export function searchEmojis(query: string): string[] {
  return searchIn(query, currentLocale());
}
