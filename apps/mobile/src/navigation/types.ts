import type { ApiMessage, SpaceFile } from "@ruchoir/client";
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
  /** The tutorial again, from Help. */
  tutorial: { replay: true };
  /** Create or join a space, from the space sheet. */
  joinSpace: undefined;
  /** My account's screens and sheets (mockup 11). */
  statusSheet: undefined;
  profile: undefined;
  preferences: undefined;
  languageSheet: undefined;
  security: undefined;
  help: undefined;
  /** A time zone chosen for the form under it, handed back under `key` (`account/choice.ts`). */
  zonePicker: { key: string; current: string };
  changePassword: undefined;
  totp: { mode: "enable" | "disable" };
  recoveryCodes: { codes: string[] };
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
  /** `entry` and `path` for a space file, whose menu the viewer offers. */
  fileViewer: { file: ViewerFile; entry?: SpaceFile; path?: string };
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
  /** "Add a file" into a folder of a space (its root without `folderId`), named for the questions. */
  filesAdd: { spaceId: string; folderId?: string; folderName: string };
  /** The files on their way, and the question about a name already taken. */
  uploads: undefined;
  /** "Scan a document" into a folder of a space. */
  scan: { spaceId: string; folderId?: string; folderName: string };
  /** An entry's menu and what it opens; `path` is where the entry sits ("Clients / 2026"). */
  fileMenu: { file: SpaceFile; spaceId: string; path?: string };
  fileName: { mode: "create" | "rename"; spaceId: string; folderId?: string; fileId?: string; name?: string };
  fileDetails: { file: SpaceFile; spaceId: string; path?: string };
  fileMove: { file: SpaceFile; spaceId: string };
  fileVersions: { file: SpaceFile; spaceId: string };
  fileShare: { file: SpaceFile; spaceId: string };
  fileSendTo: { file: SpaceFile; spaceId: string };
  fileLinks: { file: SpaceFile };
  uploadConflict: undefined;
  spaceSheet: undefined;
  accountSheet: undefined;
};

declare global {
  namespace ReactNavigation {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface RootParamList extends RootParams {}
  }
}

/** An invitation read from a pasted link and previewed: where it leads, and who sent it. */
export type InvitationChoice = {
  token: string;
  spaceName: string;
  invitedBy?: string;
  /** The address it was sent to, when it names one. */
  email?: string;
};

/** The screens before signing in (`AuthNavigator`). */
export type AuthParams = {
  welcome: undefined;
  tutorial: { replay?: boolean } | undefined;
  signIn: undefined;
  signUp: { invitation?: InvitationChoice } | undefined;
  invitationLink: undefined;
  verifyEmail: undefined;
  forgotPassword: { email?: string } | undefined;
};
