/**
 * The app's own `ruchoir://` links, which the widgets open (step 6e): a screen to go to, or nothing
 * for an address that is not one of them. `ruchoir://auth` and `ruchoir://passkey` belong to the
 * browser sign-in (`auth/browser.ts`), and the development launcher has its own: all left alone.
 * Free of React Native so Node tests it.
 */

export type LinkTarget =
  | { screen: "eventForm" }
  | { screen: "newMessage" }
  /** "Add a file" (the Android shortcuts): to the current space's root. */
  | { screen: "addFile" }
  /** "Search" (the Android shortcuts): the whole space. */
  | { screen: "search" }
  /** An event (the widgets' rows). */
  | { screen: "event"; eventId: string; start?: string }
  /** The reminder mail's button (`/e/<space>?prolong=<guest>`): that guest's end date, on the member screen. */
  | { screen: "prolong"; spaceSlug: string; userId: string }
  | { screen: "tab"; tab: "today" | "discussions" | "agenda" | "files" }
  | {
      screen: "conversation";
      spaceId?: string;
      params: { conversationId: string; title: string; channelId?: string; kind: "channel" | "person" };
    };

const TABS = ["today", "discussions", "agenda", "files"] as const;

/** `/e/<space>?prolong=<guest id>`, on any host or as `ruchoir://e/<space>`: nothing else (a channel path is not this link). */
function prolongLink(url: string): LinkTarget | null {
  const match = /^(?:https:\/\/[^/?#]+|ruchoir:\/\/)\/?e\/([^/?#]+)\/?\?([^#]*)/.exec(url);
  if (!match) return null;
  const guest = new URLSearchParams(match[2]).get("prolong") ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(guest)) return null;
  let spaceSlug: string;
  try {
    spaceSlug = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  return { screen: "prolong", spaceSlug, userId: guest.toLowerCase() };
}

/**
 * Whether a link may be followed on this phone: a mail's web address only for an instance the phone
 * holds an account on (`origins`), the app's own scheme always.
 */
export function linkAllowed(url: string, origins: string[]): boolean {
  if (!/^https:\/\//.test(url)) return true;
  if (!prolongLink(url)) return true;
  const host = /^https:\/\/[^/?#]+/.exec(url)?.[0].toLowerCase();
  return !!host && origins.some((o) => o.toLowerCase().replace(/\/$/, "") === host);
}

export function linkTarget(url: string): LinkTarget | null {
  const prolong = prolongLink(url);
  if (prolong) return prolong;
  const match = /^ruchoir:\/\/\/?([^?#]*)(?:\?([^#]*))?/.exec(url);
  if (!match) return null;
  const [first, second] = match[1].split("/");
  const query = new URLSearchParams(match[2] ?? "");
  switch (first) {
    case "new-event":
      return { screen: "eventForm" };
    case "new-message":
      return { screen: "newMessage" };
    case "add-file":
      return { screen: "addFile" };
    case "search":
      return { screen: "search" };
    case "event":
      return second ? { screen: "event", eventId: second, start: query.get("start") ?? undefined } : null;
    case "conversation": {
      if (!second) return null;
      const channel = query.get("channel") === "1";
      return {
        screen: "conversation",
        spaceId: query.get("space") ?? undefined,
        params: {
          conversationId: second,
          title: query.get("title") ?? "Ruchoir",
          channelId: channel ? second : undefined,
          kind: channel ? "channel" : "person",
        },
      };
    }
    default: {
      const tab = TABS.find((t) => t === first);
      return tab ? { screen: "tab", tab } : null;
    }
  }
}

/**
 * The instance a link is about, when it names one (`server=https://...`): a widget that draws what
 * comes from every instance says which each row belongs to (ADR 0007). Only an `https://` origin is
 * taken; anything else leaves the link to the instance on screen.
 */
export function linkServer(url: string): string | undefined {
  // The mail's own address names its instance.
  if (prolongLink(url)) return /^https:\/\/[^/?#]+/.exec(url)?.[0].toLowerCase();
  const query = /^ruchoir:\/\/\/?[^?#]*\?([^#]*)/.exec(url)?.[1];
  const server = query ? new URLSearchParams(query).get("server") : null;
  return server && /^https:\/\/[^/?#]+$/.test(server) ? server : undefined;
}
