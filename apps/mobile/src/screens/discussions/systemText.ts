/**
 * What a notice says, by its event: a message row draws it in the history, a conversation row as the
 * channel's latest news. The server stores the event, never the words.
 */
import type { SystemEvent } from "@ruchoir/client";

import { key } from "../../i18n";

export const SYSTEM_TEXT: Record<SystemEvent, ReturnType<typeof key>> = {
  member_joined: key("system.memberJoined"),
  member_left: key("system.memberLeft"),
  member_removed: key("system.memberRemoved"),
  channel_joined: key("system.channelJoined"),
  channel_left: key("system.channelLeft"),
  channel_removed: key("system.channelRemoved"),
  channel_created: key("system.channelCreated"),
  channel_renamed: key("system.channelRenamed"),
  channel_topic_changed: key("system.channelTopicChanged"),
  channel_topic_cleared: key("system.channelTopicCleared"),
  channel_made_private: key("system.channelMadePrivate"),
  channel_made_public: key("system.channelMadePublic"),
  channel_archived: key("system.channelArchived"),
  channel_unarchived: key("system.channelUnarchived"),
  channel_access_changed: key("system.channelAccessChanged"),
  calendar_event_posted: key("system.calendarEventPosted"),
  calendar_event_changed: key("system.calendarEventChanged"),
  calendar_event_cancelled: key("system.calendarEventCancelled"),
};
