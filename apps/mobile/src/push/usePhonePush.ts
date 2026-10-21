/**
 * The signed-in app's side of phone notifications (ADR 0006), mounted by the active instance's
 * `RootNavigator`:
 *
 * - a tap on a notification opens what it is about (`push/tap.ts`), the app's space switched first,
 *   also when the tap is what launched the app: the accounts show its instance first and the tap
 *   waits here for this navigation (`accounts/useLinkRouter`, ADR 0007);
 * - once, the first time, the invitation to turn them on (mockup 08, `notificationsIntro`);
 * - while the app is in front, nothing is drawn by the system: the app shows what arrives itself;
 * - notifications read on another device leave this phone's screen, and the icon's count follows
 *   (`syncRead`), on the realtime event while the app is open, on the silent sync push otherwise.
 *
 * Handing the sessions to the extensions and registering the phone with every instance happen in the
 * accounts (`accounts/AccountsProvider`), whatever instance is on screen.
 */
import type { NavigationContainerRefWithCurrent } from "@react-navigation/native";
import * as SecureStore from "expo-secure-store";
import { useCallback, useEffect } from "react";

import { onLink, takeLink } from "../accounts/pendingLink";
import type { RootParams } from "../navigation/types";
import { useSpace } from "../space/SpaceProvider";
import { useReloadOn } from "../data/useReloadOn";
import { syncRead, WAKE_TASK } from "./background";
import { notifications } from "./native";
import { phonePushState } from "./phone";
import { tapTarget } from "./tap";

/** Set once the invitation was shown on this phone, whatever the answer. */
const ASKED = "ruchoir.notificationsAsked";

notifications()?.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: false,
    shouldShowList: false,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

export function usePhonePush(navigation: NavigationContainerRefWithCurrent<RootParams>, instanceId: string): { onReady: () => void } {
  const { select } = useSpace();

  /** Open the tap waiting for this instance, once the navigation can; true when there was one. */
  const openWaiting = useCallback(() => {
    if (!navigation.isReady()) return false;
    const link = takeLink(instanceId, "push");
    if (link?.kind !== "push") return false;
    const target = tapTarget(link.data);
    if (!target) return true;
    if (target.spaceId) select(target.spaceId);
    if (target.screen === "conversation") navigation.navigate("conversation", target.params);
    else navigation.navigate("tabs", { screen: "agenda" });
    return true;
  }, [navigation, instanceId, select]);

  useEffect(() => {
    const unsubscribe = onLink(() => void openWaiting());
    const Notifications = notifications();
    // Android: wakes and syncs; iPhone: syncs only (its extension handles the wakes).
    if (Notifications) void Notifications.registerTaskAsync(WAKE_TASK).catch(() => {});
    return unsubscribe;
  }, [openWaiting]);

  useReloadOn((e) => e.type === "notification" && e.read === true, () => void syncRead(), 800);

  const onReady = useCallback(() => {
    if (openWaiting()) return;
    if (!notifications()) return;
    void (async () => {
      if (await SecureStore.getItemAsync(ASKED)) return;
      if ((await phonePushState()) !== "off") return;
      await SecureStore.setItemAsync(ASKED, "1");
      navigation.navigate("notificationsIntro");
    })();
  }, [navigation, openWaiting]);

  return { onReady };
}
