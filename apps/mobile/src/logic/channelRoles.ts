/**
 * Who may do what inside one channel: the web's ladder (`ChannelDialogs`), mirrored to offer only
 * what the API would accept. It is the politeness, not the guard.
 */

/** The roles a channel membership can hold, weakest first. `admin` reads as "moderator". */
export const CHANNEL_ROLES = ["member", "admin", "owner"] as const;

/** Where a channel role sits in {@link CHANNEL_ROLES}; an unknown one ranks lowest. */
export function channelRank(role: string): number {
  return (CHANNEL_ROLES as readonly string[]).indexOf(role) + 1;
}

/** The roles `mine` may give to someone holding `theirs`: only below my rank, only to someone below me. */
export function grantableChannelRoles(mine: string, theirs: string): string[] {
  if (channelRank(mine) === 0 || channelRank(theirs) >= channelRank(mine)) return [];
  return CHANNEL_ROLES.filter((role) => channelRank(role) < channelRank(mine));
}
