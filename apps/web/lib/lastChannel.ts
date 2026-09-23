/**
 * The conversation last open in each space, so going back to a space lands where it was left.
 *
 * Entering a space used to open its first channel every time, which meant scrolling back to the
 * conversation one had just stepped away from. This is navigation memory rather than a preference,
 * so it lives beside the settings instead of inside them: it changes on every click, and routing it
 * through the settings context would re-render the whole shell each time.
 *
 * Kept in `localStorage`, per browser, like the settings. A missing or unreadable entry simply means
 * "no memory", and the caller falls back to the space's default channel.
 */

const STORAGE_KEY = "ruchoir.lastChannels";

function readAll(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

/** The conversation last open in a space, if this browser remembers one. */
export function lastChannelOf(spaceId: string): string | undefined {
  return readAll()[spaceId];
}

/** Remember the conversation now open in a space. */
export function rememberChannel(spaceId: string, conversationId: string): void {
  if (!spaceId || !conversationId) return;
  const all = readAll();
  if (all[spaceId] === conversationId) return;
  all[spaceId] = conversationId;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Storage refused (private mode, quota): the space opens on its default channel instead.
  }
}
