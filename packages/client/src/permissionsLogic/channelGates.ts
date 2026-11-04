import { rightsOf } from "./spaceGates.ts";

/**
 * What the caller may do in one channel, each control on the right the API checks behind it. When
 * the instance announces the permissions and the channel carries `myPermissions`, that list is the
 * whole answer (a custom role that moderates, an administrator by role who was given nothing in
 * this channel). Otherwise the rule an older instance applied: a guest takes part but moderates
 * nothing, the space's owner and administrators run every channel, and `legacyChannelRole` (the
 * caller's own row in the channel, when the screen has it) lets a channel's administrator moderate.
 *
 * The server stays the judge: this only keeps the interface from offering what would be refused.
 * Deleting a channel is a space-level right (`channels.delete`), not the channel's.
 */
export function channelGates(
  channel: { myPermissions?: string[] } | undefined,
  space: { role: string; myPermissions?: string[] } | undefined,
  supported: boolean,
  legacyChannelRole?: string,
) {
  const mine = supported ? channel?.myPermissions : undefined;
  if (mine) {
    const has = (p: string) => mine.includes(p);
    return {
      strict: true,
      send: has("message.send"),
      react: has("message.react"),
      attach: has("message.attach"),
      mentionAll: has("message.mention_all"),
      pin: has("message.pin"),
      moderate: has("message.manage"),
      manage: has("channel.manage"),
      manageMembers: has("channel.members.manage"),
      addPeople: has("channel.members.manage"),
      remove: rightsOf(space).includes("channels.delete"),
    };
  }
  const guest = space?.role === "guest";
  const runs = !guest && (["owner", "admin"].includes(space?.role ?? "") || ["owner", "admin"].includes(legacyChannelRole ?? ""));
  const spaceRuns = ["owner", "admin"].includes(space?.role ?? "");
  return {
    strict: false,
    send: true,
    react: true,
    attach: true,
    mentionAll: true,
    pin: !guest,
    moderate: runs,
    manage: runs,
    manageMembers: runs,
    addPeople: runs,
    remove: spaceRuns,
  };
}

/**
 * The creating buttons of a space (new channel, new direct message, new calendar), on the right
 * each is checked against. An older instance keeps its rule: a guest creates no channel nor
 * calendar, and anyone may write to a person.
 */
export function createGates(space: { role: string; myPermissions?: string[] } | undefined, supported: boolean) {
  if (supported && space?.myPermissions) {
    const has = (p: string) => space.myPermissions!.includes(p);
    return { channel: has("channels.create"), dm: has("dm.start"), calendar: has("calendars.create") };
  }
  const guest = space?.role === "guest";
  return { channel: !guest, dm: true, calendar: !guest };
}
