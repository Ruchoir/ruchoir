/**
 * Each permission of the catalogue in plain words: a short name and one sentence saying what it
 * lets someone do (`docs/specs/permissions/design.md`, the catalogue tables). Keyed by the
 * permission's published name, which never changes.
 */
export const PERMISSION_TEXT: Record<string, { title: string; desc: string }> = {
  "space.settings": { title: "perm.spaceSettings", desc: "perm.spaceSettingsDesc" },
  "members.view": { title: "perm.membersView", desc: "perm.membersViewDesc" },
  "members.invite": { title: "perm.membersInvite", desc: "perm.membersInviteDesc" },
  "members.manage": { title: "perm.membersManage", desc: "perm.membersManageDesc" },
  "roles.manage": { title: "perm.rolesManage", desc: "perm.rolesManageDesc" },
  "groups.manage": { title: "perm.groupsManage", desc: "perm.groupsManageDesc" },
  "audit.view": { title: "perm.auditView", desc: "perm.auditViewDesc" },
  "channels.create": { title: "perm.channelsCreate", desc: "perm.channelsCreateDesc" },
  "channels.delete": { title: "perm.channelsDelete", desc: "perm.channelsDeleteDesc" },
  "calendars.create": { title: "perm.calendarsCreate", desc: "perm.calendarsCreateDesc" },
  "dm.start": { title: "perm.dmStart", desc: "perm.dmStartDesc" },
  "files.trash.purge": { title: "perm.filesTrashPurge", desc: "perm.filesTrashPurgeDesc" },
  "channel.view": { title: "perm.channelView", desc: "perm.channelViewDesc" },
  "message.send": { title: "perm.messageSend", desc: "perm.messageSendDesc" },
  "message.react": { title: "perm.messageReact", desc: "perm.messageReactDesc" },
  "message.attach": { title: "perm.messageAttach", desc: "perm.messageAttachDesc" },
  "message.mention_all": { title: "perm.messageMentionAll", desc: "perm.messageMentionAllDesc" },
  "message.pin": { title: "perm.messagePin", desc: "perm.messagePinDesc" },
  "message.manage": { title: "perm.messageManage", desc: "perm.messageManageDesc" },
  "channel.members.manage": { title: "perm.channelMembersManage", desc: "perm.channelMembersManageDesc" },
  "channel.manage": { title: "perm.channelManage", desc: "perm.channelManageDesc" },
  "files.view": { title: "perm.filesView", desc: "perm.filesViewDesc" },
  "files.create": { title: "perm.filesCreate", desc: "perm.filesCreateDesc" },
  "files.edit": { title: "perm.filesEdit", desc: "perm.filesEditDesc" },
  "files.manage": { title: "perm.filesManage", desc: "perm.filesManageDesc" },
  "files.public_link": { title: "perm.filesPublicLink", desc: "perm.filesPublicLinkDesc" },
  "calendar.view": { title: "perm.calendarView", desc: "perm.calendarViewDesc" },
  "calendar.write": { title: "perm.calendarWrite", desc: "perm.calendarWriteDesc" },
  "calendar.manage": { title: "perm.calendarManage", desc: "perm.calendarManageDesc" },
};

/** The four families' names, in the editor's order. */
export const FAMILY_TEXT: Record<"space" | "channels" | "files" | "calendars", string> = {
  space: "sidebar.space",
  channels: "tabs.channels",
  files: "gsearch.files",
  calendars: "calendar.calendars",
};
