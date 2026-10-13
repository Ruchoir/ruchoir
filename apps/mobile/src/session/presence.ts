import type { Presence, PresenceChoice } from "@ruchoir/client";

/** The dot the signed-in person sees on their own avatar: connected, unless they chose otherwise. */
export function selfPresence(choice: PresenceChoice): Presence {
  switch (choice) {
    case "away":
      return "away";
    case "busy":
      return "busy";
    case "invisible":
      return "offline";
    default:
      return "online";
  }
}
