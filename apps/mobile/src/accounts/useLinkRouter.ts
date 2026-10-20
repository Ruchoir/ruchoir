/**
 * The front door of a tapped notification and of the app's own `ruchoir://` links (ADR 0007), also
 * when one is what launched the app: the instance it is about is shown first, then the link waits
 * for that instance's navigation (`pendingLink.ts`), which opens it once ready.
 *
 * A notification names its instance (`server`, written by the extension or the background task), and
 * so does a widget's link to what came from one instance (`server=`, `logic/deepLink.ts`); any other
 * link is the active instance's. Mounted once, above the scopes.
 */
import type { NotificationResponse } from "expo-notifications";
import { useEffect, useRef } from "react";
import { Linking } from "react-native";

import { linkServer } from "../logic/deepLink";
import { notifications } from "../push/native";
import { useAccounts } from "./AccountsProvider";
import { queueLink, type PendingLink } from "./pendingLink";

export function useLinkRouter(): void {
  const { accounts, active, booted, switchTo } = useAccounts();
  const handled = useRef(new Set<string>());
  // Links that came before the accounts were read: followed once they are.
  const early = useRef<{ server?: string; link: PendingLink }[]>([]);
  const route = useRef<(server: string | undefined, link: PendingLink) => void>(() => {});

  useEffect(() => {
    route.current = (server, link) => {
      if (!booted) {
        early.current.push({ server, link });
        return;
      }
      const target = (server && accounts.find((a) => a.origin === server && a.status.kind === "signedIn")) || active;
      if (!target) return;
      const spaceId = link.kind === "push" && typeof link.data.space_id === "string" ? link.data.space_id : undefined;
      switchTo(target.id, spaceId);
      queueLink(target.id, link);
    };
    if (booted && early.current.length > 0) {
      const waiting = early.current;
      early.current = [];
      waiting.forEach(({ server, link }) => route.current(server, link));
    }
  }, [accounts, active, booted, switchTo]);

  useEffect(() => {
    const Notifications = notifications();
    const respond = (response: NotificationResponse) => {
      const id = response.notification.request.identifier;
      if (handled.current.has(id)) return;
      handled.current.add(id);
      const data = (response.notification.request.content.data ?? {}) as Record<string, unknown>;
      route.current(typeof data.server === "string" ? data.server : undefined, { kind: "push", data });
    };
    const subscription = Notifications?.addNotificationResponseReceivedListener(respond);
    void Notifications?.getLastNotificationResponseAsync().then((response) => response && respond(response));
    const links = Linking.addEventListener("url", ({ url }) => route.current(linkServer(url), { kind: "url", url }));
    void Linking.getInitialURL().then((url) => url && route.current(linkServer(url), { kind: "url", url }));
    return () => {
      subscription?.remove();
      links.remove();
    };
  }, []);
}
