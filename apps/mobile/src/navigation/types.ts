import type { ApiMessage } from "@ruchoir/client";
import type { NavigatorScreenParams } from "@react-navigation/native";

export type TabParams = {
  today: undefined;
  discussions: undefined;
  agenda: undefined;
  files: undefined;
};

export type ViewerFile = { id: string; name: string; url: string; mime?: string; sizeBytes?: number };

export type RootParams = {
  tabs: NavigatorScreenParams<TabParams>;
  /**
   * A channel or a direct conversation; `channelId` is set for a channel (its agenda tab needs it).
   * `unread` is how many messages were new when it was opened, which places the "New messages" line;
   * `kind` tells a conversation with one person (where "Seen" shows) from a group.
   */
  conversation: {
    conversationId: string;
    title: string;
    channelId?: string;
    members?: number;
    unread?: number;
    kind?: "channel" | "person" | "group";
    /** The others in a private conversation with several people, for the faces in its head. */
    participants?: string[];
  };
  folder: { folderId: string; name: string };
  /** A file to show: a space file, a message's attachment or an event's, by its download URL. */
  fileViewer: { file: ViewerFile };
  /** An event opened; `start` is where the occurrence was shown (a date of a series is found near it). */
  eventSummary: { eventId: string; recurrenceId?: string; start?: string };
  /**
   * The event form: a new event on `day` (linked to `channelId` when planned from a channel), or the
   * event `eventId` changed (the date `recurrenceId` of a series).
   */
  eventForm: { day?: string; channelId?: string; eventId?: string; recurrenceId?: string; start?: string };
  /** The event form's sheets, each on the form's draft (`formKey`, see `draftStore`). */
  eventCalendar: { formKey: string };
  /** A date or time of the form; `until` is the day a custom repetition stops. */
  eventPicker: { formKey: string; field: "startDay" | "endDay" | "startTime" | "endTime" | "until" };
  eventRepeat: { formKey: string };
  eventInvitees: { formKey: string };
  eventChannel: { formKey: string };
  eventZone: { formKey: string };
  /** The scope of a change to a date of a series, handed back to `key` (see `scope.ts`). */
  eventScope: { key: string; title: string; action: "edit" | "delete" };
  eventRule: { formKey: string };
  /** The form's reminders (`formKey`), or one's own reminders for the event `eventId`, saved at once. */
  eventReminders: { formKey: string; eventId?: undefined } | { eventId: string; formKey?: undefined };
  /**
   * A message's long-press sheet; `channelId` is set in a channel (pinning needs it), `draftKey` names
   * the composer an edit goes to, and `inThread` hides "Reply in thread" where that is where one is.
   */
  messageActions: {
    conversationId: string;
    channelId?: string;
    /** The conversation's name, for the head of a thread opened from here. */
    title: string;
    draftKey: string;
    inThread?: boolean;
    message: ApiMessage;
  };
  /** "New message" and what it leads to: a conversation with people, a group, an invitation. */
  newMessage: undefined;
  newConversation: undefined;
  newGroup: undefined;
  invite: undefined;
  /** A conversation's details: its topic, my notifications, its pinned messages, its people. */
  conversationDetails: { conversationId: string; channelId?: string; title: string };
  /** A thread: its root message, in its conversation. */
  thread: { conversationId: string; channelId?: string; rootId: string; title: string; root?: ApiMessage };
  emojiPicker: { conversationId: string; message: ApiMessage };
  /** "Add to the message", for the composer whose draft is `draftKey`. */
  attachSheet: { draftKey: string; title?: string; spaceId?: string };
  /** A space's files to pick from: `spaceId`'s, else the current space's. */
  spaceFilePicker: { draftKey: string; spaceId?: string };
  spaceSheet: undefined;
  accountSheet: undefined;
};

declare global {
  namespace ReactNavigation {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface RootParamList extends RootParams {}
  }
}
