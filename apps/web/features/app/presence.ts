import type { Presence } from "@/components/ds";
import { key, type TranslationKey } from "@/lib/i18n";

/**
 * The dictionary key naming a presence state.
 *
 * A key rather than the sentence: this is called from components in several places, and each of
 * them already holds a translator. Returning text here would have meant either a second way of
 * reaching the dictionaries from outside React, or four sentences frozen in French.
 */
export function presenceLabelKey(presence: Presence): TranslationKey {
  switch (presence) {
    case "online":
      return key("presence.online");
    case "away":
      return key("presence.away");
    case "busy":
      return key("presence.busy");
    default:
      return key("presence.offline");
  }
}
