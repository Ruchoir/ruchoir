/**
 * Follows the app's own `ruchoir://` links (`logic/deepLink.ts`): the widgets' shortcuts, also when
 * one is what launched the app. The accounts catch them and hand them to the active instance's
 * navigation (`accounts/useLinkRouter`); mounted by `RootNavigator`, beside the notifications' taps.
 */
import type { NavigationContainerRefWithCurrent } from "@react-navigation/native";
import { useCallback, useEffect } from "react";

import { onLink, takeLink } from "../accounts/pendingLink";
import { linkTarget } from "../logic/deepLink";
import { useSpace } from "../space/SpaceProvider";
import type { RootParams } from "./types";

export function useAppLinks(navigation: NavigationContainerRefWithCurrent<RootParams>, instanceId: string): { onReady: () => void } {
  const { select, current } = useSpace();

  const follow = useCallback(
    (url: string) => {
      const target = linkTarget(url);
      if (!target) return;
      switch (target.screen) {
        case "eventForm":
          navigation.navigate("eventForm", {});
          return;
        case "newMessage":
          navigation.navigate("newMessage");
          return;
        case "addFile":
          if (current) navigation.navigate("filesAdd", { spaceId: current.id, folderName: current.name });
          return;
        case "search":
          navigation.navigate("search");
          return;
        case "event":
          navigation.navigate("eventSummary", { eventId: target.eventId, start: target.start });
          return;
        case "tab":
          navigation.navigate("tabs", { screen: target.tab });
          return;
        case "conversation":
          if (target.spaceId) select(target.spaceId);
          navigation.navigate("conversation", target.params);
      }
    },
    [navigation, select, current],
  );

  /** Follow the link waiting for this instance, once the navigation can. */
  const followWaiting = useCallback(() => {
    if (!navigation.isReady()) return;
    const link = takeLink(instanceId, "url");
    if (link?.kind === "url") follow(link.url);
  }, [navigation, instanceId, follow]);

  useEffect(() => onLink(followWaiting), [followWaiting]);

  const onReady = followWaiting;

  return { onReady };
}
