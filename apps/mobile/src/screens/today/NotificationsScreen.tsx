/**
 * "Notifications", from Today's bell: the inbox of every instance the phone is signed in to, as the
 * web's notification centre, unread ones or all of them, newest first, older pages as the list runs
 * out. A tap files it as read and
 * opens what it is about (the message in its conversation, or the event); "Mark all as read" files
 * them all at once.
 */
import type { ApiNotification } from "@ruchoir/client";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { AtSign, Bell, CalendarDays, CheckCheck, MessageCircle, PenLine, Reply, Share2, SmilePlus } from "lucide-react-native";
import { useEffect, useState } from "react";
import { FlatList, Pressable, StyleSheet, View } from "react-native";

import { useAccounts } from "../../accounts/AccountsProvider";
import { mergeInboxes, type InboxItem } from "../../accounts/inbox";
import { queueLink } from "../../accounts/pendingLink";
import { hostOf, unreadEverywhere } from "../../accounts/summary";
import { useLoad } from "../../data/useLoad";
import { useNow } from "../../data/useNow";
import { useReloadOn } from "../../data/useReloadOn";
import { key, useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { listStamp } from "../../logic/format";
import { plainExcerpt } from "../../logic/inline";
import type { RootParams } from "../../navigation/types";
import { useRealtimeActions } from "../../realtime/RealtimeProvider";
import { useSpace } from "../../space/SpaceProvider";
import { radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { Button } from "../../ui/Button";
import { Segmented } from "../../ui/Segmented";
import { SheetHeader } from "../../ui/SheetHeader";
import { EmptyState, LoadState } from "../../ui/States";
import { Text } from "../../ui/Text";
import { useToast } from "../../ui/Toast";

type Filter = "unread" | "all";

/** What a notification says after the actor's name, by kind. */
const SAID: Record<ApiNotification["kind"], ReturnType<typeof key>> = {
  mention: key("inbox.mentioned"),
  broadcast: key("inbox.broadcast"),
  reply: key("inbox.replied"),
  dm: key("inbox.dm"),
  message: key("inbox.wrote"),
  reaction: key("inbox.reacted"),
  edited: key("inbox.edited"),
  calendar_reminder: key("inbox.reminder"),
  calendar_invitation: key("inbox.invitation"),
  calendar_update: key("inbox.invitationUpdate"),
  calendar_cancel: key("inbox.invitationCancel"),
  calendar_declined: key("inbox.invitationDeclined"),
  calendar_shared: key("inbox.calendarShared"),
};

const ICON = {
  mention: AtSign,
  broadcast: AtSign,
  reply: Reply,
  dm: MessageCircle,
  message: MessageCircle,
  reaction: SmilePlus,
  edited: PenLine,
  calendar_shared: Share2,
} as const;

/** One page cursor per instance, for the older pages fetched as the list runs out. */
type Older = Record<string, { items: ApiNotification[]; next?: string }>;

/**
 * Pages of the inbox of every signed-in instance (ADR 0007), merged newest first
 * (`accounts/inbox.ts`): the first pages reload live, the older ones are appended per instance.
 */
export function NotificationsScreen() {
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const { locale, timeZone } = useLocale();
  const now = useNow();
  const toast = useToast();
  const { emit } = useRealtimeActions();
  const { current, select } = useSpace();
  const accounts = useAccounts();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const [filter, setFilter] = useState<Filter>("unread");
  const signedIn = accounts.accounts.filter((a) => a.status.kind === "signedIn");
  const several = signedIn.length > 1;
  const clientOf = (instanceId: string) => signedIn.find((a) => a.id === instanceId)?.client;
  const ids = signedIn.map((a) => a.id).join(" ");
  const first = useLoad(`inbox:${filter}:${ids}`, (signal) =>
    Promise.all(
      signedIn.map(async (account) => {
        // An instance that does not answer leaves the others' notifications on screen.
        const page = await account.client.getNotifications({ unread: filter === "unread", limit: 30 }, signal).catch((err: unknown) => {
          if (signedIn.length === 1) throw err;
          return null;
        });
        return { instanceId: account.id, items: page?.notifications ?? [], next: page?.nextBefore };
      }),
    ),
  );
  useReloadOn((e) => e.type === "notification", first.reload, 300);
  // Another instance's inbox moves through its summary, published by its own scope.
  const elsewhere = unreadEverywhere(accounts.summaries, signedIn.filter((a) => a.id !== accounts.active?.id).map((a) => a.id));
  const reloadFirst = first.reload;
  useEffect(() => {
    if (several) reloadFirst();
  }, [elsewhere, several, reloadFirst]);
  const [older, setOlder] = useState<{ key: string; feeds: Older; loading: boolean }>({ key: "", feeds: {}, loading: false });
  // Read here, ahead of the server's answer.
  const [readHere, setReadHere] = useState<Set<string>>(new Set());

  const pageKey = `${filter}:${(first.data ?? []).map((f) => f.items[0]?.id ?? "").join(",")}`;
  const olderHere = older.key === pageKey ? older.feeds : {};
  const feeds = (first.data ?? []).map((feed) => {
    const more = olderHere[feed.instanceId];
    return more ? { instanceId: feed.instanceId, items: [...feed.items, ...more.items], next: more.next } : feed;
  });
  const merged = mergeInboxes(feeds);
  const items = merged.items.map((n) => (readHere.has(n.key) ? { ...n, read: true } : n));
  const anyUnread = items.some((n) => !n.read);

  const more = () => {
    if (!merged.more || (older.key === pageKey && older.loading) || !first.data) return;
    setOlder((prev) => ({ key: pageKey, feeds: prev.key === pageKey ? prev.feeds : {}, loading: true }));
    void Promise.all(
      feeds
        .filter((feed) => feed.next)
        .map(async (feed) => {
          const page = await clientOf(feed.instanceId)
            ?.getNotifications({ unread: filter === "unread", before: feed.next, limit: 30 })
            .catch(() => null);
          return { feed, page };
        }),
    ).then((pages) =>
      setOlder((prev) => {
        const base = prev.key === pageKey ? prev.feeds : {};
        const next = { ...base };
        for (const { feed, page } of pages) {
          if (!page) continue;
          const had = base[feed.instanceId]?.items ?? [];
          next[feed.instanceId] = { items: [...had, ...page.notifications], next: page.nextBefore };
        }
        return { key: pageKey, feeds: next, loading: false };
      }),
    );
  };

  const readAll = () => {
    setReadHere(new Set(items.map((n) => n.key)));
    Promise.all(signedIn.map((account) => account.client.markAllNotificationsRead())).then(
      () => {
        toast(t("inbox.allMarked"));
        emit({ type: "notification" });
      },
      () => {
        setReadHere(new Set());
        toast(t("message.actionFailed"), "failure");
      },
    );
  };

  const open = (n: InboxItem) => {
    if (!n.read) {
      setReadHere((prev) => new Set(prev).add(n.key));
      clientOf(n.instanceId)
        ?.markNotificationRead(n.id)
        .then(() => emit({ type: "notification" }), () => {});
    }
    navigation.goBack();
    // Another instance's: shown first, then what the notification is about, as a tap would.
    if (n.instanceId !== accounts.active?.id) {
      accounts.switchTo(n.instanceId, n.spaceId || undefined);
      const data: Record<string, string> = {};
      if (n.spaceId) data.space_id = n.spaceId;
      if (n.conversationId) data.conversation_id = n.conversationId;
      if (n.channelName) data.channel_name = n.channelName;
      if (n.actor) data.actor_name = n.actor;
      if (n.reminder) data.event_id = n.reminder.eventId;
      queueLink(n.instanceId, { kind: "push", data });
      return;
    }
    if (n.reminder) {
      navigation.navigate("eventSummary", { eventId: n.reminder.eventId, recurrenceId: n.reminder.recurrenceId, start: n.reminder.start });
      return;
    }
    if (n.kind === "calendar_shared" || !n.conversationId) {
      navigation.navigate("tabs", { screen: "agenda" });
      return;
    }
    if (n.spaceId && n.spaceId !== current?.id) select(n.spaceId);
    navigation.navigate("conversation", {
      conversationId: n.conversationId,
      title: n.channelName ?? n.actor,
      channelId: n.channelName ? n.conversationId : undefined,
      kind: n.channelName ? "channel" : undefined,
      focus: n.messageId ? { id: n.messageId } : undefined,
    });
  };

  const headline = (n: ApiNotification) => {
    const title = n.reminder?.title ?? n.calendarName ?? "";
    switch (n.kind) {
      case "calendar_reminder":
        return t("inbox.reminder", { title });
      case "calendar_invitation":
        return t("inbox.invitation", { actor: n.actor, title });
      case "calendar_update":
        return t("inbox.invitationUpdate", { actor: n.actor, title });
      case "calendar_cancel":
        return t("inbox.invitationCancel", { actor: n.actor, title });
      case "calendar_declined":
        return t("inbox.invitationDeclined", { actor: n.actor, title });
      default:
        return `${n.actor} ${t(SAID[n.kind])}${n.emoji ? ` ${n.emoji}` : ""}`;
    }
  };

  return (
    <View style={[styles.fill, { backgroundColor: c.surface }]}>
      <SheetHeader title={t("details.notifications")} onClose={() => navigation.goBack()} />
      <View style={styles.bar}>
        <Segmented
          options={[
            { key: "unread", label: t("discussions.filterUnread") },
            { key: "all", label: t("discussions.filterAll") },
          ]}
          value={filter}
          onChange={setFilter}
        />
      </View>
      {anyUnread ? (
        <View style={styles.markAll}>
          <Button variant="secondary" size="sm" label={t("inbox.markAllRead")} icon={<CheckCheck size={16} color={c.ink} />} onPress={readAll} />
        </View>
      ) : null}
      {!first.data ? (
        <LoadState error={first.error} onRetry={first.reload} />
      ) : items.length === 0 ? (
        filter === "unread" ? (
          <EmptyState size="hero" icon={CheckCheck} title={t("widgets.allRead")} text={t("inbox.allReadText")} />
        ) : (
          <EmptyState size="hero" icon={Bell} title={t("inbox.nothingNew")} text={t("inbox.nothingNewText")} />
        )
      ) : (
        <FlatList
          data={items}
          keyExtractor={(n) => n.key}
          contentContainerStyle={styles.list}
          onEndReached={more}
          onEndReachedThreshold={0.5}
          ItemSeparatorComponent={() => <View style={[styles.rule, { backgroundColor: c.line }]} />}
          renderItem={({ item: n }) => {
            const Icon = n.kind.startsWith("calendar_") && n.kind !== "calendar_shared" ? CalendarDays : ICON[n.kind as keyof typeof ICON] ?? Bell;
            const stamp = listStamp(n.createdAt, new Date(now), locale, timeZone);
            const place = n.reminder ? n.reminder.calendarName : n.channelName ? `#${n.channelName} · ${n.spaceName}` : n.spaceName || undefined;
            // With several instances, each item says which one it comes from.
            const origin = several ? signedIn.find((a) => a.id === n.instanceId)?.origin : undefined;
            const where = origin ? [place, hostOf(origin)].filter(Boolean).join(" · ") : place;
            return (
              <Pressable accessibilityRole="button" onPress={() => open(n)} style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}>
                <View style={[styles.tile, { backgroundColor: n.read ? s.sunken : c.acc }]}>
                  <Icon size={18} color={n.read ? c.muted : c.onPastel} />
                </View>
                <View style={styles.body}>
                  <View style={styles.line}>
                    <Text variant={n.read ? "small" : "smallStrong"} numberOfLines={2} style={styles.shrink}>
                      {headline(n)}
                    </Text>
                    {stamp ? (
                      <Text variant="tiny" tone="muted">
                        {stamp.kind === "yesterday" ? t("time.yesterday") : stamp.text}
                      </Text>
                    ) : null}
                  </View>
                  {n.preview ? (
                    <Text variant="small" tone="muted" numberOfLines={2}>
                      {plainExcerpt(n.preview)}
                    </Text>
                  ) : null}
                  {where ? (
                    <Text variant="tiny" tone="muted" numberOfLines={1}>
                      {where}
                    </Text>
                  ) : null}
                </View>
                {!n.read ? <View style={[styles.dot, { backgroundColor: c.alarm }]} /> : null}
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  bar: { paddingBottom: 8 },
  markAll: { paddingHorizontal: 16, paddingBottom: 8, alignItems: "flex-start" },
  list: { paddingBottom: 32 },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingHorizontal: 16, paddingVertical: 10 },
  tile: { width: 40, height: 40, borderRadius: radius.m, alignItems: "center", justifyContent: "center" },
  body: { flex: 1, minWidth: 0, gap: 2 },
  line: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 8 },
  shrink: { flexShrink: 1 },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 16 },
  rule: { height: 1, marginLeft: 68 },
});
