import {
  fileDownloadUrl,
  getFilesView,
  getNotifications,
  listCalendars,
  listOccurrences,
  type ApiNotification,
  type Occurrence,
  type SpaceFile,
} from "@ruchoir/client";
import { useFocusEffect, useNavigation, type NavigationProp } from "@react-navigation/native";
import { AtSign, CalendarDays, ChevronRight, Sparkles } from "lucide-react-native";
import { useCallback, useMemo, useRef } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";

import { useLoad } from "../../data/useLoad";
import { useNow } from "../../data/useNow";
import { useReloadOn } from "../../data/useReloadOn";
import { affects } from "../../realtime/events";
import { key, useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { addDays } from "../../logic/agenda";
import { listConversations } from "../../logic/conversations";
import { dayKey, timeOf } from "../../logic/format";
import { pickNowCards } from "../../logic/today";
import type { RootParams } from "../../navigation/types";
import { useSession } from "../../session/SessionProvider";
import { useSpace } from "../../space/SpaceProvider";
import { hairline, radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { Button } from "../../ui/Button";
import { feel } from "../../ui/haptics";
import { EmptyState } from "../../ui/States";
import { FileIcon } from "../../ui/FileIcon";
import { TabHeader } from "../../ui/TabHeader";
import { TabScreen } from "../../ui/TabScreen";
import { Text } from "../../ui/Text";
import { ConversationRow, loadConversations, useMemberOf } from "../discussions/DiscussionsScreen";

const SPOKEN_TITLE = {
  mention: key("today.mentioned"),
  reply: key("today.replied"),
  dm: key("today.wrote"),
  broadcast: key("today.broadcast"),
};

/**
 * Today (mockup 09): a greeting, what to look at now (a message for the reader, the next event of
 * the day, a new file) and the latest conversations.
 */
export function TodayScreen() {
  const { t } = useTranslation();
  const { c } = useTheme();
  const { locale, timeZone } = useLocale();
  const navigation = useNavigation<NavigationProp<RootParams>>();
  const { state } = useSession();
  const { current } = useSpace();
  const space = current?.id;
  const now = useNow();
  const today = dayKey(new Date(now), timeZone);

  const notifications = useLoad("notifications", (signal) => getNotifications({ unread: true, limit: 30 }, signal));
  const events = useLoad(space ? `today:${space}:${today}` : null, async (signal) => {
    const calendars = (await listCalendars(signal)).filter((cal) => !cal.hidden && (!cal.spaceId || cal.spaceId === space));
    if (!calendars.length) return [] as Occurrence[];
    return listOccurrences(`${addDays(today, -1)}T00:00:00Z`, `${addDays(today, 2)}T00:00:00Z`, calendars.map((cal) => cal.id), signal);
  });
  const recent = useLoad(space ? `recent:${space}` : null, (signal) => getFilesView(space!, "recent", signal));
  const conversations = useLoad(space ? `conversations:${space}` : null, (signal) => loadConversations(space!, signal));
  const memberOf = useMemberOf(space);
  const reloadAll = () => {
    notifications.reload();
    events.reload();
    recent.reload();
    conversations.reload();
  };
  const pulled = () => {
    feel("refresh");
    reloadAll();
  };
  useReloadOn((e) => e.type === "notification" || e.type === "message" || e.type === "readCursor", notifications.reload);
  useReloadOn((e) => !!space && affects.conversations(e, space), conversations.reload);
  useReloadOn((e) => e.type === "calendar", events.reload);
  useReloadOn((e) => e.type === "files", recent.reload);
  // Coming back to the tab (from a conversation, another tab) reads the cards again: a live event
  // missed while the socket was asleep must not leave a card read elsewhere, or hide a new one.
  const shown = useRef(false);
  const reloadNotifications = notifications.reload;
  const reloadConversations = conversations.reload;
  useFocusEffect(
    useCallback(() => {
      if (!shown.current) {
        shown.current = true;
        return;
      }
      reloadNotifications();
      reloadConversations();
    }, [reloadNotifications, reloadConversations]),
  );

  const cards = useMemo(
    () =>
      space
        ? pickNowCards({
            notifications: notifications.data?.notifications ?? [],
            occurrences: events.data ?? [],
            recentFiles: recent.data?.map((entry) => entry.file) ?? [],
            now: new Date(now),
            spaceId: space,
            timeZone,
          })
        : [],
    [notifications.data, events.data, recent.data, space, timeZone, now],
  );
  const latest = conversations.data ? listConversations(conversations.data, "all", "").slice(0, 3) : [];
  const firstName = state.kind === "signedIn" ? state.user.name.split(/\s+/)[0] : "";
  const date = new Intl.DateTimeFormat(locale, { timeZone, weekday: "long", day: "numeric", month: "long" }).format(new Date(now));
  const mention = cards.find((card) => card.kind === "mention");
  const small = cards.filter((card) => card.kind !== "mention");


  return (
    <TabScreen>
      <TabHeader overline={date.charAt(0).toLocaleUpperCase(locale) + date.slice(1)} title={t("today.hello", { name: firstName })} />
      <ScrollView contentContainerStyle={styles.page} refreshControl={<RefreshControl refreshing={false} onRefresh={pulled} />}>
        <View style={styles.section}>
          <Text variant="heading" style={styles.sectionTitle}>
            {t("today.now")}
          </Text>
          {mention?.kind === "mention" ? <MentionCard n={mention.notification} /> : null}
          {small.length ? (
            <View style={styles.pair}>
              {small.map((card) =>
                card.kind === "event" ? (
                  <EventTile key="event" occurrence={card.occurrence} now={now} />
                ) : card.kind === "file" ? (
                  <FileTile key="file" file={card.file} />
                ) : null,
              )}
            </View>
          ) : null}
          {!cards.length && notifications.data && events.data ? (
            <View style={[styles.calm, { borderColor: c.line, backgroundColor: c.surface }]}>
              <EmptyState size="compact" icon={Sparkles} title={t("today.calm")} text={t("today.calmHint")} />
            </View>
          ) : null}
        </View>
        <View style={styles.section}>
          <View style={styles.sectionHead}>
            <Text variant="heading" style={styles.flex}>
              {t("today.recent")}
            </Text>
            <Button variant="link" size="sm" label={t("today.seeAll")} onPress={() => navigation.navigate("tabs", { screen: "discussions" })} />
          </View>
        </View>
        {latest.map((item) => (
          <ConversationRow
            key={item.id}
            item={item}
            memberOf={memberOf}
            onPress={() =>
              navigation.navigate("conversation", {
                conversationId: item.id,
                title: item.name,
                channelId: item.kind === "channel" ? item.id : undefined,
                unread: item.unread,
                kind: item.kind,
                participants: item.participants,
              })
            }
          />
        ))}
      </ScrollView>
    </TabScreen>
  );

}

function MentionCard({ n }: { n: ApiNotification }) {
  const { t } = useTranslation();
  const { locale, timeZone } = useLocale();
  const navigation = useNavigation<NavigationProp<RootParams>>();
  const { c } = useTheme();
  const kind = n.kind as keyof typeof SPOKEN_TITLE;
  const where = n.channelName ? t("today.inChannel", { name: n.channelName }) : t("today.direct");
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() =>
        navigation.navigate("conversation", {
          conversationId: n.conversationId,
          title: n.channelName ?? n.actor,
          // A channel's conversation is the channel itself.
          channelId: n.channelName ? n.conversationId : undefined,
        })
      }
      style={({ pressed }) => [styles.mention, { borderColor: c.ink, backgroundColor: c.surface, shadowColor: c.ink }, pressed && { opacity: 0.8 }]}
    >
      <View style={[styles.mentionIcon, { backgroundColor: c.acc }]}>
        <AtSign size={22} color={c.onPastel} />
      </View>
      <View style={styles.flex}>
        <Text variant="bodyStrong">{t(SPOKEN_TITLE[kind] ?? SPOKEN_TITLE.mention, { who: n.actor.split(/\s+/)[0] })}</Text>
        {n.preview ? (
          <Text variant="small" tone="body" numberOfLines={2}>
            {t("today.quote", { text: n.preview })}
          </Text>
        ) : null}
        <Text variant="tiny" tone="muted">
          {`${where} · ${timeOf(n.createdAt, locale, timeZone)}`}
        </Text>
      </View>
      <View style={styles.open}>
        <Text variant="smallStrong">{t("today.open")}</Text>
        <ChevronRight size={16} color={c.ink} />
      </View>
    </Pressable>
  );
}

function EventTile({ occurrence: o, now }: { occurrence: Occurrence; now: number }) {
  const { t } = useTranslation();
  const { locale, timeZone } = useLocale();
  const navigation = useNavigation<NavigationProp<RootParams>>();
  const { c } = useTheme();
  const minutes = Math.round((Date.parse(o.start) - now) / 60_000);
  const when =
    minutes <= 0
      ? t("today.ongoing")
      : minutes < 60
        ? t("today.inMinutes", { count: minutes })
        : t("today.inHours", { count: Math.round(minutes / 60) });
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => navigation.navigate("eventSummary", { eventId: o.eventId, recurrenceId: o.recurrenceId, start: o.start })}
      style={({ pressed }) => [styles.tile, { borderColor: c.line, backgroundColor: c.surface }, pressed && { opacity: 0.7 }]}
    >
      <View style={[styles.tileIcon, { backgroundColor: c.sky }]}>
        <CalendarDays size={18} color={c.onPastel} />
      </View>
      <Text variant="bodyStrong" numberOfLines={1}>
        {o.title}
      </Text>
      <Text variant="small" tone="body" numberOfLines={1}>{`${timeOf(o.start, locale, timeZone)} · ${when}`}</Text>
    </Pressable>
  );
}

function FileTile({ file }: { file: SpaceFile }) {
  const { t } = useTranslation();
  const navigation = useNavigation<NavigationProp<RootParams>>();
  const { c } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() =>
        file.id &&
        navigation.navigate("fileViewer", {
          file: { id: file.id, name: file.name, url: fileDownloadUrl(file.id), mime: file.mimeType, sizeBytes: file.sizeBytes },
        })
      }
      style={({ pressed }) => [styles.tile, { borderColor: c.line, backgroundColor: c.surface }, pressed && { opacity: 0.7 }]}
    >
      <FileIcon name={file.name} mime={file.mimeType} size={32} />
      <Text variant="bodyStrong" numberOfLines={1}>
        {t("today.newFile")}
      </Text>
      {/* Cut in the middle, so its extension still says what it is. */}
      <Text variant="small" tone="body" numberOfLines={1} ellipsizeMode="middle">
        {file.name}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // The tab's head stays above the page (it does not scroll away); the gap it had below it, here.
  page: { paddingTop: 8, paddingBottom: 24, gap: 8 },
  section: { paddingHorizontal: 16, gap: 12, paddingTop: 8 },
  sectionTitle: { fontSize: 17 },
  sectionHead: { flexDirection: "row", alignItems: "center" },
  flex: { flex: 1, minWidth: 0, gap: 4 },
  mention: {
    flexDirection: "row",
    gap: 14,
    alignItems: "flex-start",
    padding: 16,
    borderRadius: radius.l,
    borderWidth: 2,
    shadowOffset: { width: 3, height: 3 },
    shadowOpacity: 1,
    shadowRadius: 0,
    elevation: 3,
  },
  mentionIcon: { width: 44, height: 44, borderRadius: radius.m, alignItems: "center", justifyContent: "center" },
  open: { flexDirection: "row", alignItems: "center", alignSelf: "center", gap: 2 },
  pair: { flexDirection: "row", gap: 12 },
  // Two small cards side by side (mockup 09): a tile, a title and one line, each on one line.
  tile: { flex: 1, minWidth: 0, gap: 6, padding: 12, borderRadius: radius.l, borderWidth: hairline },
  tileIcon: { width: 32, height: 32, borderRadius: radius.s, alignItems: "center", justifyContent: "center" },
  calm: { borderRadius: radius.l, borderWidth: hairline },
});
