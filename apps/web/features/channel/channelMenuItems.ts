import type { Channel } from "@/lib/data";
import type { Translate } from "@/lib/i18n";

/** One entry of a channel's "more" menu, wherever it is drawn. */
export type ChannelMenuItem = { icon: string; label: string; onClick: () => void; danger?: boolean };

/**
 * What a channel's menu can do. An entry is offered when its action is given, so each caller decides
 * what the reader may do and the list itself stays the same everywhere.
 */
export type ChannelMenuActions = {
  onToggleFavourite?: () => void;
  onMarkRead?: () => void;
  onNotifications: () => void;
  /** Absent when the person holds neither `channel.manage` nor `channel.members.manage` here. */
  onSettings?: () => void;
  /** Plan an event linked to the channel: absent for an archived channel or one the reader left. */
  onPlanEvent?: () => void;
  /** Decide who is in the channel: absent for anyone who does not moderate it. */
  onAddPeople?: () => void;
  /** Make it the space's default channel: absent unless the reader runs the space and it qualifies. */
  onSetDefault?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onLeave: () => void;
  /** Rejoin a public channel the reader had left. */
  onJoin: () => void;
};

/**
 * The one recipe behind a channel's "more" menu, in the sidebar and in the channel header alike:
 * what both offer comes in the same order with the same icons. The two used to be written apart and
 * had drifted (a bell here, an inbox there). The header leaves out the list-only entries.
 */
export function channelMenuItems(
  t: Translate,
  channel: Pick<Channel, "fav" | "member">,
  a: ChannelMenuActions,
): ChannelMenuItem[] {
  const items: (ChannelMenuItem | false | undefined)[] = [
    a.onToggleFavourite && {
      icon: channel.fav ? "star-off" : "star",
      label: channel.fav ? t("sidebar.unfavourite") : t("sidebar.favourite"),
      onClick: a.onToggleFavourite,
    },
    a.onMarkRead && { icon: "check-check", label: t("sidebar.markRead"), onClick: a.onMarkRead },
    { icon: "bell", label: t("notif.title"), onClick: a.onNotifications },
    a.onSettings && { icon: "settings", label: t("sidebar.channelSettings"), onClick: a.onSettings },
    a.onPlanEvent && { icon: "calendar-plus", label: t("calendar.planEvent"), onClick: a.onPlanEvent },
    a.onAddPeople && { icon: "user-plus", label: t("channel.addPeople"), onClick: a.onAddPeople },
    a.onSetDefault && { icon: "house", label: t("sidebar.setDefaultChannel"), onClick: a.onSetDefault },
    // The pointer-free way to arrange the space, and the only one on a touch screen.
    a.onMoveUp && { icon: "arrow-up", label: t("sidebar.moveUp"), onClick: a.onMoveUp },
    a.onMoveDown && { icon: "arrow-down", label: t("sidebar.moveDown"), onClick: a.onMoveDown },
    // A public channel stays readable after leaving it, so the entry flips to rejoining rather than
    // disappearing: leaving is not a one-way door.
    channel.member === false
      ? { icon: "user-plus", label: t("sidebar.joinChannel"), onClick: a.onJoin }
      : { icon: "log-out", label: t("sidebar.leaveChannel"), onClick: a.onLeave, danger: true },
  ];
  return items.filter((it): it is ChannelMenuItem => !!it);
}

/** Whether a channel may become the space's default: public, open to every role, not already it. */
export function canBeDefaultChannel(channel: Channel, defaultChannelId?: string): boolean {
  return channel.id !== defaultChannelId && channel.type === "public" && !channel.allowedRoles?.length;
}

/**
 * The space's order with `id` moved next to `target`. The order is one list for the whole space;
 * the favourites and the rest are two views of it, so a move is made in the whole list.
 */
export function movedChannel(
  channels: Channel[],
  id: string,
  target: string,
  where: "before" | "after",
): string[] | null {
  if (id === target) return null;
  const ids = channels.map((c) => c.id).filter((x) => x !== id);
  const at = ids.indexOf(target);
  if (at === -1) return null;
  ids.splice(where === "before" ? at : at + 1, 0, id);
  return ids.join() === channels.map((c) => c.id).join() ? null : ids;
}

/**
 * The order with the channel one step up (-1) or down (1) within the section it is shown in, which
 * is the neighbour the reader sees. Null when it is already at that end.
 */
export function steppedChannel(channels: Channel[], id: string, step: -1 | 1): string[] | null {
  const channel = channels.find((c) => c.id === id);
  if (!channel) return null;
  const section = channels.filter((c) => c.fav === channel.fav);
  const neighbour = section[section.findIndex((c) => c.id === id) + step];
  return neighbour ? movedChannel(channels, id, neighbour.id, step === -1 ? "before" : "after") : null;
}
