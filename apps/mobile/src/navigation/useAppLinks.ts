/**
 * Follows the app's own `ruchoir://` links (`logic/deepLink.ts`): the widgets' shortcuts, also when
 * one is what launched the app. Mounted once by `RootNavigator`, beside the notifications' taps.
 */
import type { NavigationContainerRefWithCurrent } from "@react-navigation/native";
import { useCallback, useEffect, useRef } from "react";
import { Linking } from "react-native";

import { linkTarget } from "../logic/deepLink";
import { useSpace } from "../space/SpaceProvider";
import type { RootParams } from "./types";

export function useAppLinks(navigation: NavigationContainerRefWithCurrent<RootParams>): { onReady: () => void } {
  const { select, current } = useSpace();
  const pending = useRef<string | null>(null);

  const follow = useCallback(
    (url: string) => {
      const target = linkTarget(url);
      if (!target) return;
      if (!navigation.isReady()) {
        pending.current = url;
        return;
      }
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

  useEffect(() => {
    void Linking.getInitialURL().then((url) => url && follow(url));
    const subscription = Linking.addEventListener("url", ({ url }) => follow(url));
    return () => subscription.remove();
  }, [follow]);

  const onReady = useCallback(() => {
    const url = pending.current;
    pending.current = null;
    if (url) follow(url);
  }, [follow]);

  return { onReady };
}
