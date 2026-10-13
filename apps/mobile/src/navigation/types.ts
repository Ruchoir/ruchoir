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
  /** A channel or a direct conversation; `channelId` is set for a channel (its agenda tab needs it). */
  conversation: { conversationId: string; title: string; channelId?: string; members?: number };
  folder: { folderId: string; name: string };
  /** A file to show: a space file, a message's attachment or an event's, by its download URL. */
  fileViewer: { file: ViewerFile };
  eventSummary: { eventId: string; recurrenceId?: string };
  spaceSheet: undefined;
  accountSheet: undefined;
};

declare global {
  namespace ReactNavigation {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface RootParamList extends RootParams {}
  }
}
