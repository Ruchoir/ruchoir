/**
 * Follows the app's own `ruchoir://` links (`logic/deepLink.ts`): the widgets' shortcuts, also when
 * one is what launched the app. The accounts catch them and hand them to the active instance's
 * navigation (`accounts/useLinkRouter`); mounted by `RootNavigator`, beside the notifications' taps.
 */
import type { NavigationContainerRefWithCurrent } from "@react-navigation/native";
import { useCallback, useEffect, useRef } from "react";

import { onLink, takeLink } from "../accounts/pendingLink";
import { linkTarget } from "../logic/deepLink";
import { prolongStep } from "../logic/guestNotices";
import { useSpace } from "../space/SpaceProvider";
import type { RootParams } from "./types";

export function useAppLinks(navigation: NavigationContainerRefWithCurrent<RootParams>, instanceId: string): { onReady: () => void } {
  const { select, current, spaces } = useSpace();
  // The reminder mail's link, waiting for the space list when the app was just opened by it.
  const prolonging = useRef<{ spaceSlug: string; userId: string } | null>(null);

  const openProlong = useCallback(() => {
    const wanted = prolonging.current;
    if (!wanted) return;
    const step = prolongStep(spaces.data, wanted.spaceSlug);
    if (step.kind === "wait") return;
    // Whatever happens next, this link is spent: a space that is not in the list never opens later, unprompted.
    prolonging.current = null;
    if (step.kind === "drop") return;
    select(step.space.id);
    navigation.navigate("spaceMember", { userId: wanted.userId, prolong: true, spaceId: step.space.id });
  }, [navigation, select, spaces.data]);

  useEffect(() => {
    if (spaces.data) openProlong();
  }, [spaces.data, openProlong]);

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
        case "prolong":
          prolonging.current = { spaceSlug: target.spaceSlug, userId: target.userId };
          openProlong();
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
    [navigation, select, current, openProlong],
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
