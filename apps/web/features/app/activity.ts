/**
 * Cross-channel activity collectors for the Threads / Mentions / Saved views.
 *
 * These operate on AppRoot's live message map (channel id -> messages) so that saving,
 * pinning or deleting a message is reflected immediately in the filtered views. Channel
 * labels are resolved from the channel and direct-message lists.
 */
import type { Channel, DirectMessage, Message } from "@/lib/data";

export type ActivityItem = {
  channelId: string;
  /** Display label: "#canal" for channels, the person's name for direct messages. */
  label: string;
  isDm: boolean;
  message: Message;
};

export type MessageMap = Record<string, Message[]>;

/**
 * One line standing in for a message wherever it is listed rather than rendered: pinned messages,
 * mentions, saved items, search hits.
 *
 * A message sent with a file and no text has an empty body, and "(pièce jointe)" told the reader
 * nothing at all: which file, of what kind, none of it. The attachment already carries a name, and
 * an image carries its alternative text or its file name, so there is always something truer to
 * say. The generic wording survives only for the case that has genuinely nothing.
 */
export function messageSummary(m: Message): string {
  if (m.body) return m.body;
  if (m.image) return m.image.alt;
  if (m.attachment) return m.attachment.name;
  return "(pièce jointe)";
}

function labelFor(channelId: string, channels: Channel[], dms: DirectMessage[]): { label: string; isDm: boolean } {
  const channel = channels.find((c) => c.id === channelId);
  if (channel) return { label: `#${channel.name}`, isDm: false };
  const dm = dms.find((d) => d.id === channelId);
  if (dm) return { label: dm.name, isDm: true };
  return { label: channelId, isDm: false };
}

function collect(
  map: MessageMap,
  channels: Channel[],
  dms: DirectMessage[],
  predicate: (m: Message) => boolean,
): ActivityItem[] {
  const items: ActivityItem[] = [];
  for (const [channelId, messages] of Object.entries(map)) {
    const { label, isDm } = labelFor(channelId, channels, dms);
    for (const message of messages) {
      if (message.deleted) continue;
      if (predicate(message)) items.push({ channelId, label, isDm, message });
    }
  }
  return items;
}

/** Messages the current user bookmarked. */
export function collectSaved(map: MessageMap, channels: Channel[], dms: DirectMessage[]): ActivityItem[] {
  return collect(map, channels, dms, (m) => !!m.saved);
}

/** Messages whose body @-mentions the current user (by full name or first name). */
export function collectMentions(
  map: MessageMap,
  channels: Channel[],
  dms: DirectMessage[],
  me: string,
): ActivityItem[] {
  const firstName = me.split(" ")[0];
  return collect(
    map,
    channels,
    dms,
    (m) => m.body.includes(`@${me}`) || m.body.includes(`@${firstName}`),
  );
}

/** Thread roots (messages that carry replies), newest activity first is left to the caller. */
export function collectThreads(map: MessageMap, channels: Channel[], dms: DirectMessage[]): ActivityItem[] {
  return collect(map, channels, dms, (m) => !!m.replies && m.replies > 0);
}

/** Every non-deleted message across all conversations, with its channel label (for global search). */
export function flattenMessages(map: MessageMap, channels: Channel[], dms: DirectMessage[]): ActivityItem[] {
  return collect(map, channels, dms, () => true);
}
