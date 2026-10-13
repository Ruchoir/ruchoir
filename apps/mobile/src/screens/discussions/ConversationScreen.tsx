import {
  getChannelMessages,
  listChannelMembers,
  setReadCursor,
  type ApiMessage,
} from "@ruchoir/client";
import { useRoute, type RouteProp } from "@react-navigation/native";
import { CalendarDays, FileText, MessageSquare, PenLine } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useSpaceMembers } from "../../data/members";
import { useLoad } from "../../data/useLoad";
import { key, useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { dayKey, daysBetween } from "../../logic/format";
import type { RootParams } from "../../navigation/types";
import { mergeMessages } from "../../realtime/merge";
import { useRealtimeEvent } from "../../realtime/RealtimeProvider";
import { useSession } from "../../session/SessionProvider";
import { useSpace } from "../../space/SpaceProvider";
import { hairline, radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { Avatar } from "../../ui/Avatar";
import { BackHeader } from "../../ui/BackHeader";
import { Chips } from "../../ui/Chips";
import { EmptyState, LoadState } from "../../ui/States";
import { Text } from "../../ui/Text";
import { ConversationAgenda } from "./ConversationAgenda";
import { ConversationFiles } from "./ConversationFiles";
import { MessageRow } from "./MessageRow";

type Pane = "messages" | "files" | "agenda";
const PANES = [
  { key: "messages", label: key("conversation.messages"), icon: MessageSquare },
  { key: "files", label: key("tabs.files"), icon: FileText },
  { key: "agenda", label: key("tabs.agenda"), icon: CalendarDays },
] as const;

/** Two messages by one person less than five minutes apart read as one block. */
const RUN_GAP_MS = 5 * 60 * 1000;

type Row = { kind: "message"; message: ApiMessage; head: boolean } | { kind: "day"; day: string };

/** A conversation (mockup 13): its messages live, its files and, for a channel, its events. */
export function ConversationScreen() {
  const { params } = useRoute<RouteProp<RootParams, "conversation">>();
  const { t } = useTranslation();
  const { c } = useTheme();
  const { current } = useSpace();
  const members = useSpaceMembers(current?.id);
  const [pane, setPane] = useState<Pane>("messages");
  const channelMembers = useLoad(params.channelId ? `channelMembers:${params.channelId}` : null, (signal) =>
    listChannelMembers(params.channelId!, signal),
  );
  const subtitle = channelMembers.data ? t("conversation.people", { count: channelMembers.data.length }) : undefined;

  return (
    <SafeAreaView edges={["top"]} style={styles.fill}>
      <BackHeader
        title={params.title}
        subtitle={subtitle}
        leading={<Avatar name={params.title} kind={params.channelId ? "workspace" : "person"} src={params.channelId ? undefined : members.avatarOf(params.title)} size={36} />}
      />
      <View style={[styles.tabs, { borderBottomColor: c.line }]}>
      <Chips
        chips={PANES.filter((p) => p.key !== "agenda" || params.channelId).map((p) => ({ key: p.key, label: t(p.label), icon: p.icon }))}
        value={pane}
        onChange={setPane}
      />
      </View>
      <View style={styles.fill}>
        {pane === "messages" ? (
          <Messages conversationId={params.conversationId} members={members} />
        ) : pane === "files" ? (
          <ConversationFiles conversationId={params.conversationId} />
        ) : (
          <ConversationAgenda channelId={params.channelId!} />
        )}
      </View>
    </SafeAreaView>
  );
}

function Messages({ conversationId, members }: { conversationId: string; members: ReturnType<typeof useSpaceMembers> }) {
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const { locale, timeZone } = useLocale();
  const { state } = useSession();
  const me = state.kind === "signedIn" ? state.user : null;
  const first = useLoad(`messages:${conversationId}`, (signal) => getChannelMessages(conversationId, {}, signal));
  const [extra, setExtra] = useState<{ messages: ApiMessage[]; nextBefore?: string; loadingMore: boolean }>({
    messages: [],
    loadingMore: false,
  });
  const messages = useMemo(() => mergeMessages(first.data?.messages ?? [], extra.messages), [first.data, extra.messages]);
  const nextBefore = extra.nextBefore ?? first.data?.nextBefore;

  // Live: a message here is merged in; an edit or a deletion replaces the copy on screen.
  useRealtimeEvent((event) => {
    if (event.type === "message" && event.conversationId === conversationId) {
      setExtra((prev) => ({ ...prev, messages: mergeMessages(prev.messages, [event.message]) }));
    }
  });

  // Reading is the one write of this screen: the newest message on screen is the read cursor.
  const marked = useRef<string | null>(null);
  const newest = messages[messages.length - 1]?.id;
  useEffect(() => {
    if (!newest || marked.current === newest) return;
    marked.current = newest;
    void setReadCursor(conversationId, newest).catch(() => {
      marked.current = null;
    });
  }, [conversationId, newest]);

  const loadOlder = useCallback(async () => {
    if (!nextBefore || extra.loadingMore) return;
    setExtra((prev) => ({ ...prev, loadingMore: true }));
    try {
      const page = await getChannelMessages(conversationId, { before: nextBefore });
      setExtra((prev) => ({ messages: mergeMessages(prev.messages, page.messages), nextBefore: page.nextBefore ?? "", loadingMore: false }));
    } catch {
      setExtra((prev) => ({ ...prev, loadingMore: false }));
    }
  }, [conversationId, nextBefore, extra.loadingMore]);

  // Newest first, for an inverted list that opens at the bottom; a day's label follows its messages.
  const rows = useMemo(() => {
    const out: Row[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      const older = messages[i - 1];
      const day = dayKey(m.createdAt, timeZone);
      const sameRun =
        older &&
        older.kind !== "system" &&
        m.kind !== "system" &&
        older.author === m.author &&
        dayKey(older.createdAt, timeZone) === day &&
        Date.parse(m.createdAt) - Date.parse(older.createdAt) < RUN_GAP_MS;
      out.push({ kind: "message", message: m, head: !sameRun });
      if (!older || dayKey(older.createdAt, timeZone) !== day) out.push({ kind: "day", day });
    }
    return out;
  }, [messages, timeZone]);

  const myNames = useMemo(() => {
    if (!me) return [];
    const words = me.name.split(/\s+/).filter(Boolean);
    return [me.name, words[0], words.join("")].map((n) => `@${n}`.toLowerCase());
  }, [me]);
  const today = dayKey(new Date(), timeZone);

  if (!first.data) return <LoadState error={first.error} onRetry={first.reload} />;

  return (
    <View style={styles.fill}>
      {rows.length === 0 ? (
        <EmptyState icon={MessageSquare} title={t("conversation.empty")} text={t("conversation.emptyHint")} />
      ) : (
      <FlatList
        inverted
        data={rows}
        keyExtractor={(row) => (row.kind === "day" ? `day:${row.day}` : row.message.id)}
        onEndReached={() => void loadOlder()}
        onEndReachedThreshold={0.4}
        ListFooterComponent={extra.loadingMore ? <ActivityIndicator color={c.ink} style={styles.more} /> : null}
        renderItem={({ item }) => {
          if (item.kind === "day") {
            const gap = daysBetween(item.day, today);
            const label =
              gap === 0
                ? t("time.today")
                : gap === 1
                  ? t("time.yesterday")
                  : new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(
                      new Date(`${item.day}T12:00:00Z`),
                    );
            return (
              <View style={styles.day}>
                <View style={[styles.rule, { backgroundColor: c.line }]} />
                <Text variant="tiny" tone="muted">
                  {label}
                </Text>
                <View style={[styles.rule, { backgroundColor: c.line }]} />
              </View>
            );
          }
          const body = item.message.body.toLowerCase();
          return (
            <MessageRow
              message={item.message}
              head={item.head}
              mentionsMe={myNames.some((n) => body.includes(n))}
              avatar={members.avatarOf(item.message.author)}
              mentionNames={members.mentionNames}
            />
          );
        }}
      />
      )}
      <SafeAreaView edges={["bottom"]} style={[styles.soon, { borderTopColor: c.line, backgroundColor: c.surface }]}>
        <View style={[styles.soonPill, { backgroundColor: s.sunken }]}>
          <PenLine size={16} color={c.muted} />
          <Text variant="small" tone="muted">
            {t("conversation.writingSoon")}
          </Text>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  tabs: { paddingBottom: 8, borderBottomWidth: hairline },
  more: { padding: 16 },
  day: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 10 },
  rule: { flex: 1, height: hairline },
  soon: { borderTopWidth: hairline, paddingHorizontal: 16, paddingTop: 10 },
  soonPill: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, height: 44, borderRadius: radius.m, marginBottom: 6 },
});
