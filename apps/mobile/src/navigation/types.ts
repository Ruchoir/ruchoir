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
  };
  folder: { folderId: string; name: string };
  /** A file to show: a space file, a message's attachment or an event's, by its download URL. */
  fileViewer: { file: ViewerFile };
  eventSummary: { eventId: string; recurrenceId?: string };
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
  /** A thread: its root message, in its conversation. */
  thread: { conversationId: string; channelId?: string; rootId: string; title: string; root?: ApiMessage };
  emojiPicker: { conversationId: string; message: ApiMessage };
  /** "Add to the message", for the composer whose draft is `draftKey`. */
  attachSheet: { draftKey: string };
  spaceFilePicker: { draftKey: string };
  spaceSheet: undefined;
  accountSheet: undefined;
};

declare global {
  namespace ReactNavigation {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface RootParamList extends RootParams {}
  }
}
