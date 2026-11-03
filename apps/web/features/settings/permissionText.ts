import { key, type TranslationKey } from "@/lib/i18n";

/**
 * Each permission of the catalogue in plain words: a short name and one sentence saying what it
 * lets someone do (`docs/specs/permissions/design.md`, the catalogue tables). Keyed by the
 * permission's published name, which never changes.
 */
export const PERMISSION_TEXT: Record<string, { title: TranslationKey; desc: TranslationKey }> = {
  "space.settings": { title: key("perm.spaceSettings"), desc: key("perm.spaceSettingsDesc") },
  "members.view": { title: key("perm.membersView"), desc: key("perm.membersViewDesc") },
  "members.invite": { title: key("perm.membersInvite"), desc: key("perm.membersInviteDesc") },
  "members.manage": { title: key("perm.membersManage"), desc: key("perm.membersManageDesc") },
  "roles.manage": { title: key("perm.rolesManage"), desc: key("perm.rolesManageDesc") },
  "groups.manage": { title: key("perm.groupsManage"), desc: key("perm.groupsManageDesc") },
  "audit.view": { title: key("perm.auditView"), desc: key("perm.auditViewDesc") },
  "channels.create": { title: key("perm.channelsCreate"), desc: key("perm.channelsCreateDesc") },
  "channels.delete": { title: key("perm.channelsDelete"), desc: key("perm.channelsDeleteDesc") },
  "calendars.create": { title: key("perm.calendarsCreate"), desc: key("perm.calendarsCreateDesc") },
  "dm.start": { title: key("perm.dmStart"), desc: key("perm.dmStartDesc") },
  "files.trash.purge": { title: key("perm.filesTrashPurge"), desc: key("perm.filesTrashPurgeDesc") },
  "channel.view": { title: key("perm.channelView"), desc: key("perm.channelViewDesc") },
  "message.send": { title: key("perm.messageSend"), desc: key("perm.messageSendDesc") },
  "message.react": { title: key("perm.messageReact"), desc: key("perm.messageReactDesc") },
  "message.attach": { title: key("perm.messageAttach"), desc: key("perm.messageAttachDesc") },
  "message.mention_all": { title: key("perm.messageMentionAll"), desc: key("perm.messageMentionAllDesc") },
  "message.pin": { title: key("perm.messagePin"), desc: key("perm.messagePinDesc") },
  "message.manage": { title: key("perm.messageManage"), desc: key("perm.messageManageDesc") },
  "channel.members.manage": { title: key("perm.channelMembersManage"), desc: key("perm.channelMembersManageDesc") },
  "channel.manage": { title: key("perm.channelManage"), desc: key("perm.channelManageDesc") },
  "files.view": { title: key("perm.filesView"), desc: key("perm.filesViewDesc") },
  "files.create": { title: key("perm.filesCreate"), desc: key("perm.filesCreateDesc") },
  "files.edit": { title: key("perm.filesEdit"), desc: key("perm.filesEditDesc") },
  "files.manage": { title: key("perm.filesManage"), desc: key("perm.filesManageDesc") },
  "files.public_link": { title: key("perm.filesPublicLink"), desc: key("perm.filesPublicLinkDesc") },
  "calendar.view": { title: key("perm.calendarView"), desc: key("perm.calendarViewDesc") },
  "calendar.write": { title: key("perm.calendarWrite"), desc: key("perm.calendarWriteDesc") },
  "calendar.manage": { title: key("perm.calendarManage"), desc: key("perm.calendarManageDesc") },
};

/** The four families' names, in the editor's order. */
export const FAMILY_TEXT: Record<"space" | "channels" | "files" | "calendars", TranslationKey> = {
  space: key("sidebar.space"),
  channels: key("tabs.channels"),
  files: key("gsearch.files"),
  calendars: key("calendar.calendars"),
};
