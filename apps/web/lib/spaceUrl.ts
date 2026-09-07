/**
 * Addresses for a space and a conversation.
 *
 * The app is a state machine, not a router, and stays one: this module gives it just enough of an
 * address to be bookmarked, shared and reopened. It never pushes a history entry, so the back button
 * leaves the app exactly as it did before, and it is read once at load rather than driving the app.
 *
 * **The space is carried by whichever of the host and the path actually has it.** Today it is the
 * path (`/e/atelier/c/general`); once a space is served on its own subdomain it will be the host
 * (`atelier.ruchoir.fr/c/general`). Both forms are read forever, so links already shared survive that
 * change, and the same rule governs writing, so the client starts emitting the short form on its own
 * the day the host carries the space. There is no flag and nothing to configure.
 *
 * The rule needs no list of reserved subdomains: a host label counts as a space only when it matches
 * a slug the signed-in account actually belongs to. A space cannot be called `www` or `api` because
 * the server refuses to mint those slugs, and any other label (`localhost`, an IP, the bare apex)
 * simply matches nothing.
 */

/** A space, and optionally a channel inside it, named by an address. */
export type SpaceLocation = { spaceSlug: string; channelName?: string };

/** Strip the export's optional trailing slash and split a path into its segments. */
function segments(pathname: string): string[] {
  return pathname.split("/").filter(Boolean);
}

/**
 * The space the host names, or `null` when it names none.
 *
 * `slugs` is the set the account belongs to: matching against it is what makes the check safe
 * without a denylist, and what makes it a no-op until subdomains exist.
 */
export function hostSpace(slugs: string[]): string | null {
  if (typeof window === "undefined") return null;
  const label = window.location.hostname.split(".")[0]?.toLowerCase() ?? "";
  if (!label) return null;
  return slugs.find((slug) => slug.toLowerCase() === label) ?? null;
}

/**
 * The space and channel the current address names, or `null` for a plain app load.
 *
 * Resolution needs the account's slugs, so it runs after the spaces have loaded: until then the
 * client cannot know whether a host label is a space or just a hostname.
 */
export function readSpaceLocation(slugs: string[]): SpaceLocation | null {
  if (typeof window === "undefined") return null;
  const parts = segments(window.location.pathname);
  const fromHost = hostSpace(slugs);

  // Explicit form: the path carries the space, whatever the host says.
  if (parts[0] === "e" && parts[1]) {
    const spaceSlug = decodeURIComponent(parts[1]);
    const channelName = parts[2] === "c" && parts[3] ? decodeURIComponent(parts[3]) : undefined;
    return { spaceSlug, channelName };
  }
  // Short form: the space came from the host, the path only names the channel.
  if (fromHost) {
    const channelName = parts[0] === "c" && parts[1] ? decodeURIComponent(parts[1]) : undefined;
    return { spaceSlug: fromHost, channelName };
  }
  return null;
}

/**
 * The address for a space and, optionally, a channel in it.
 *
 * Omits the space when the host already carries it, which is the whole adaptive rule: the same call
 * yields `/e/atelier/c/general` today and `/c/general` once `atelier` is a subdomain.
 */
export function spaceUrl(spaceSlug: string, channelName: string | undefined, slugs: string[]): string {
  const channel = channelName ? `/c/${encodeURIComponent(channelName)}` : "";
  if (hostSpace(slugs) === spaceSlug) return `${channel || "/"}`;
  return `/e/${encodeURIComponent(spaceSlug)}${channel}`;
}

/**
 * Point the address bar at a space and channel without touching the history.
 *
 * `replaceState`, deliberately: an address that is useful to copy is not the same thing as a router,
 * and half-working back/forward buttons are worse than none. Guarded, because a browser can refuse
 * history manipulation and that must never break navigation inside the app.
 */
export function writeSpaceLocation(
  spaceSlug: string,
  channelName: string | undefined,
  slugs: string[],
): void {
  if (typeof window === "undefined") return;
  try {
    const url = spaceUrl(spaceSlug, channelName, slugs);
    if (url !== window.location.pathname) window.history.replaceState(null, "", url);
  } catch {
    // History is unavailable (sandboxed frame, hardened browser): the app works, the address does
    // not follow. Not worth failing a navigation over.
  }
}
