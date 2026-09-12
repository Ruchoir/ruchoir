import type { Presence } from "@/components/ds";

/**
 * The dictionary key naming a presence state.
 *
 * A key rather than the sentence: this is called from components in several places, and each of
 * them already holds a translator. Returning text here would have meant either a second way of
 * reaching the dictionaries from outside React, or four sentences frozen in French.
 */
export function presenceLabelKey(presence: Presence): string {
  switch (presence) {
    case "online":
      return "presence.online";
    case "away":
      return "presence.away";
    case "busy":
      return "presence.busy";
    default:
      return "presence.offline";
  }
}
