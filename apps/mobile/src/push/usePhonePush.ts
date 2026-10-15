/**
 * The signed-in app's side of phone notifications (ADR 0006), mounted once by `RootNavigator`:
 *
 * - a tap on a notification opens what it is about (`push/tap.ts`), the app's space switched first,
 *   also when the tap is what launched the app;
 * - at every start, the session handed to the extensions (notifications, widgets), and a phone whose
 *   notifications are on registered again (`refreshPhonePush`);
 * - once, the first time, the invitation to turn them on (mockup 08, `notificationsIntro`);
 * - while the app is in front, nothing is drawn by the system: the app shows what arrives itself.
 */
import type { NavigationContainerRefWithCurrent } from "@react-navigation/native";
import type { NotificationResponse } from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { useCallback, useEffect, useRef } from "react";
import { Platform } from "react-native";

import type { RootParams } from "../navigation/types";
import { useSpace } from "../space/SpaceProvider";
import { WAKE_TASK } from "./background";
import { notifications } from "./native";
import { phonePushState, refreshPhonePush, shareSession } from "./phone";
import { refreshWidgets } from "../widgets";
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

export function usePhonePush(navigation: NavigationContainerRefWithCurrent<RootParams>): { onReady: () => void } {
  const { select } = useSpace();
  const pending = useRef<Record<string, unknown> | null>(null);
  const handled = useRef(new Set<string>());

  const open = useCallback(
    (data: Record<string, unknown> | undefined) => {
      const target = tapTarget(data);
      if (!target) return;
      if (!navigation.isReady()) {
        pending.current = data ?? null;
        return;
      }
      if (target.spaceId) select(target.spaceId);
      if (target.screen === "conversation") navigation.navigate("conversation", target.params);
      else navigation.navigate("tabs", { screen: "agenda" });
    },
    [navigation, select],
  );

  useEffect(() => {
    // The widgets read it too, notifications on or not: drawn again once it is there.
    void shareSession()
      .then(refreshWidgets)
      .catch(() => {});
    const Notifications = notifications();
    if (!Notifications) return;
    const respond = (response: NotificationResponse) => {
      const id = response.notification.request.identifier;
      if (handled.current.has(id)) return;
      handled.current.add(id);
      open(response.notification.request.content.data);
    };
    void Notifications.getLastNotificationResponseAsync().then((response) => response && respond(response));
    const subscription = Notifications.addNotificationResponseReceivedListener(respond);
    void refreshPhonePush();
    if (Platform.OS === "android") void Notifications.registerTaskAsync(WAKE_TASK).catch(() => {});
    return () => subscription.remove();
  }, [open]);

  const onReady = useCallback(() => {
    if (pending.current) {
      const data = pending.current;
      pending.current = null;
      open(data);
      return;
    }
    if (!notifications()) return;
    void (async () => {
      if (await SecureStore.getItemAsync(ASKED)) return;
      if ((await phonePushState()) !== "off") return;
      await SecureStore.setItemAsync(ASKED, "1");
      navigation.navigate("notificationsIntro");
    })();
  }, [navigation, open]);

  return { onReady };
}
