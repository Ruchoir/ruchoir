import type { SpaceFile } from "@ruchoir/client";
import type { NavigatorScreenParams } from "@react-navigation/native";

export type TabParams = {
  today: undefined;
  discussions: undefined;
  agenda: undefined;
  files: undefined;
};

export type RootParams = {
  tabs: NavigatorScreenParams<TabParams>;
  /** A channel or a direct conversation; `channelId` is set for a channel (its agenda tab needs it). */
  conversation: { conversationId: string; title: string; channelId?: string; members?: number };
  folder: { folderId: string; name: string };
  fileViewer: { file: SpaceFile };
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
