/**
 * Notification model for the app shell.
 *
 * The inbox comes from the API (`GET /notifications`), for the whole account rather than one space,
 * since a notification is addressed to a person. It is held as a flat, mutable list the notification
 * center reads, filtered to the space on screen at display time. Read state lives on each item so
 * marking one (or all) read never rebuilds the list. Per-channel preferences are
 * applied at display time (see `passesPref`) so muting a channel hides its notifications and drops
 * them from the unread count without discarding the read state of the others.
 */

/**
 * Why a notification exists.
 *
 * `mention` is someone typing your name. `broadcast` is `@canal` or `@ici`, which reaches you as
 * one of the room rather than as yourself: a weaker claim on your attention, and the one people
 * most often want to turn off, which is why it is a kind of its own rather than a mention like any
 * other.
 */
export type NotifKind = "mention" | "broadcast" | "reply" | "dm";

/** Whether a kind belongs under the Mentions badge: named directly, or addressed with the room. */
export function isMention(kind: NotifKind): boolean {
  return kind === "mention" || kind === "broadcast";
}

export type AppNotification = {
  id: string;
  kind: NotifKind;
  channelId: string;
  /**
   * The space it happened in.
   *
   * The inbox is fetched for the whole account, since a notification is addressed to a person and
   * not to a space, but it is *shown* for the space on screen: the rail already carries a per-space
   * count, and a mention in one space appearing in the sidebar of every other one double-reports it
   * and points at a conversation that is not there.
   */
  spaceId: string;
  /** "#canal" for channels, the person's name for direct messages. */
  label: string;
  /** The space's name, so a notification from another space can say where it happened. */
  spaceName: string;
  isDm: boolean;
  /** Who triggered the notification (drives the avatar). */
  actor: string;
  /** The message to jump to when the notification is opened. */
  messageId: string;
  /** Short one-line preview of the triggering message. */
  preview: string;
  /** Human time carried from the source message (e.g. "10:24"). */
  time: string;
  read: boolean;
};

/** How much a channel notifies. `all` is the default when a channel has no explicit preference. */
export type NotifLevel = "all" | "mentions" | "none";

export type ChannelNotifPref = {
  level: NotifLevel;
  muted: boolean;
};

export const DEFAULT_CHANNEL_PREF: ChannelNotifPref = { level: "all", muted: false };

/** Global notification preferences, persisted with the rest of the settings. */
export type NotifPrefs = {
  /** Master switch: off silences every channel. */
  enabled: boolean;
  /** Play a sound on a new notification. */
  sound: boolean;
  /** Also notify on @channel / @here, not only direct @mentions. */
  channelMentions: boolean;
  /** Suppress notifications during the configured quiet hours. */
  quietHours: boolean;
  /** Quiet-hours start, "HH:MM" (24h). May be later than `quietTo` for an overnight window. */
  quietFrom: string;
  /** Quiet-hours end, "HH:MM" (24h). */
  quietTo: string;
};

export const DEFAULT_NOTIF_PREFS: NotifPrefs = {
  enabled: true,
  sound: false,
  channelMentions: true,
  quietHours: false,
  quietFrom: "21:00",
  quietTo: "08:00",
};

/** Human summary of the quiet-hours window, e.g. "21 h 00 - 8 h 00" (French, no leading zero on hours). */
export function quietHoursLabel(prefs: NotifPrefs): string {
  // Defensive: settings persisted before these keys existed (or kept across an HMR reload) may lack
  // them, so fall back to the defaults rather than crashing on an undefined value.
  const fmt = (t: string) => {
    const [h = "0", m = "00"] = (t || "").split(":");
    return `${Number(h)} h ${m}`;
  };
  return `${fmt(prefs.quietFrom ?? DEFAULT_NOTIF_PREFS.quietFrom)} - ${fmt(prefs.quietTo ?? DEFAULT_NOTIF_PREFS.quietTo)}`;
}

/** The dictionary key naming what happened, per notification kind. */
const KIND_VERB: Record<NotifKind, string> = {
  mention: "notif.mentioned",
  broadcast: "notif.broadcast",
  reply: "notif.replied",
  dm: "notif.dm",
};

/**
 * Short sentence for a notification, e.g. "Alice vous a mentionné".
 *
 * Takes the translator rather than reaching for one: this is a plain function called from
 * components, and each of them already holds it.
 */
export function notifSummary(n: AppNotification, t: (key: string) => string): string {
  return `${n.actor} ${t(KIND_VERB[n.kind])}`;
}

/** Whether a notification should be shown given the channel and global preferences. */
export function passesPref(
  n: AppNotification,
  channelPref: ChannelNotifPref | undefined,
  prefs: NotifPrefs,
): boolean {
  if (!prefs.enabled) return false;
  // The one preference that is about the message rather than the channel it came from.
  if (n.kind === "broadcast" && !prefs.channelMentions) return false;
  const pref = channelPref ?? DEFAULT_CHANNEL_PREF;
  if (pref.muted || pref.level === "none") return false;
  if (pref.level === "mentions") return isMention(n.kind) || n.kind === "dm";
  return true;
}
