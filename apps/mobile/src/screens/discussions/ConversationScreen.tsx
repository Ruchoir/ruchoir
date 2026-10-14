import {
  getChannelMessages,
  getChannels,
  getReadCursors,
  joinChannel,
  listChannelMembers,
  setReadCursor,
  type ApiMessage,
  type Channel,
} from "@ruchoir/client";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import { Archive, ArrowDown, CalendarDays, Check, FileText, Info, MessageSquare } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Composer } from "../../compose/Composer";
import { useAttachRequests } from "../../compose/requests";
import { useAttachments } from "../../compose/useAttachments";
import { useReact } from "../../compose/useReact";
import { useSpaceMembers } from "../../data/members";
import { useLoad } from "../../data/useLoad";
import { key, useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { dayKey, daysBetween } from "../../logic/format";
import { seenMessageId } from "../../logic/receipts";
import { countNewer, firstUnreadId } from "../../logic/unread";
import type { RootParams } from "../../navigation/types";
import { useRealtimeEvent } from "../../realtime/RealtimeProvider";
import { useSession } from "../../session/SessionProvider";
import { useSpace } from "../../space/SpaceProvider";
import { fonts } from "../../theme/fonts";
import { hairline, radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { Avatar } from "../../ui/Avatar";
import { AvatarStack } from "../../ui/AvatarStack";
import { BackHeader } from "../../ui/BackHeader";
import { Button } from "../../ui/Button";
import { Chips } from "../../ui/Chips";
import { EmptyState, LoadState } from "../../ui/States";
import { Text } from "../../ui/Text";
import { KeyboardArea } from "../../ui/KeyboardArea";
import { ConversationAgenda } from "./ConversationAgenda";
import { ConversationFiles } from "./ConversationFiles";
import { useEditing, useLiveMessages, useMyMentions, useOutboxRows, useTypingLine } from "./feed";
import { MessageRow } from "./MessageRow";

type Pane = "messages" | "files" | "agenda";
const PANES = [
  { key: "messages", label: key("conversation.messages"), icon: MessageSquare },
  { key: "files", label: key("tabs.files"), icon: FileText },
  { key: "agenda", label: key("tabs.agenda"), icon: CalendarDays },
] as const;

/** Two messages by one person less than five minutes apart read as one block. */
const RUN_GAP_MS = 5 * 60 * 1000;

type Row =
  | { kind: "message"; message: ApiMessage; head: boolean }
  | { kind: "day"; day: string }
  | { kind: "unread" }
  | { kind: "seen" };

const isInFeed = (m: ApiMessage) => !m.parentId;

/** How far up (in points) the reader has to be for new messages to be announced rather than seen. */
const AWAY = 240;

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
  // A private conversation with several people says so under its name, the others' faces beside it.
  const group = !params.channelId && params.participants && params.participants.length > 1 ? params.participants : null;
  const subtitle = channelMembers.data
    ? t("conversation.people", { count: channelMembers.data.length })
    : group
      ? t("discussions.conversationOf", { count: group.length + 1 })
      : undefined;
  const channels = useLoad(current ? `channels:${current.id}` : null, (signal) => getChannels(current!.id, signal));
  const channel = params.channelId ? channels.data?.find((ch) => ch.id === params.channelId) : undefined;
  const navigation = useNavigation();
  const openDetails = () =>
    navigation.navigate("conversationDetails", { conversationId: params.conversationId, channelId: params.channelId, title: params.title });

  return (
    <SafeAreaView edges={["top"]} style={styles.fill}>
      <BackHeader
        title={params.title}
        subtitle={subtitle}
        onPressTitle={openDetails}
        trailing={
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("details.open")}
            hitSlop={6}
            onPress={openDetails}
            style={({ pressed }) => [styles.info, pressed && { opacity: 0.6 }]}
          >
            <Info size={24} color={c.ink} />
          </Pressable>
        }
        leading={
          group ? (
            <AvatarStack
              size={36}
              people={group.map((id) => {
                const member = members.list.find((m) => m.userId === id);
                return { name: member?.name ?? "", avatarUrl: member?.avatarUrl };
              })}
            />
          ) : (
            <Avatar name={params.title} kind={params.channelId ? "workspace" : "person"} src={params.channelId ? undefined : members.avatarOf(params.title)} size={36} />
          )
        }
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
          <Messages
            conversationId={params.conversationId}
            title={params.title}
            channelId={params.channelId}
            unread={params.unread}
            oneToOne={params.kind === "person"}
            channel={params.channelId ? (channel ?? null) : undefined}
            channels={channels.data ?? []}
            onJoined={channels.reload}
            members={members}
          />
        ) : pane === "files" ? (
          <ConversationFiles conversationId={params.conversationId} />
        ) : (
          <ConversationAgenda channelId={params.channelId!} />
        )}
      </View>
    </SafeAreaView>
  );
}

type MessagesProps = {
  conversationId: string;
  title: string;
  channelId?: string;
  unread?: number;
  oneToOne: boolean;
  /** The channel, for a channel (null while it loads); undefined for a private conversation. */
  channel: Channel | null | undefined;
  channels: Channel[];
  onJoined: () => void;
  members: ReturnType<typeof useSpaceMembers>;
};

function Messages({ conversationId, title, channelId, unread, oneToOne, channel, channels, onJoined, members }: MessagesProps) {
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const { locale, timeZone } = useLocale();
  const { state } = useSession();
  const me = state.kind === "signedIn" ? state.user : null;
  const navigation = useNavigation();
  const react = useReact();
  const list = useRef<FlatList<Row>>(null);
  const first = useLoad(`messages:${conversationId}`, (signal) => getChannelMessages(conversationId, {}, signal));
  // The feed holds no thread replies: they live in their thread, and move the count under their root.
  const { messages, patch, add } = useLiveMessages(conversationId, first.data?.messages, isInFeed, me, members.list);
  const [older, setOlder] = useState<{ nextBefore?: string; loading: boolean }>({ loading: false });
  const nextBefore = older.nextBefore ?? first.data?.nextBefore;
  const outbox = useOutboxRows(conversationId, undefined, messages, me);
  const { pending } = outbox;
  const edit = useEditing(conversationId, messages, patch);
  const typing = useTypingLine(conversationId, me, members.list);
  const myNames = useMyMentions(me);

  // Files picked in the attach sheet start uploading at once, above the bar.
  const attachments = useAttachments(conversationId);
  useAttachRequests(conversationId, (request) => {
    if (request.kind === "local") void attachments.add(request.files);
    else attachments.addSpaceFile(request.file);
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
    if (!nextBefore || older.loading) return;
    setOlder((prev) => ({ ...prev, loading: true }));
    try {
      const page = await getChannelMessages(conversationId, { before: nextBefore });
      add(page.messages);
      setOlder({ nextBefore: page.nextBefore ?? "", loading: false });
    } catch {
      setOlder((prev) => ({ ...prev, loading: false }));
    }
  }, [conversationId, nextBefore, older.loading, add]);

  // Where the unread messages started when the conversation opened: the line stays there while reading.
  const [anchor, setAnchor] = useState<{ id: string | null } | null>(null);
  if (anchor === null && first.data && me) setAnchor({ id: firstUnreadId(first.data.messages, unread ?? 0, me.id) });

  // "Seen" under my last message, in a conversation with one person, from the read cursors.
  const cursors = useLoad(oneToOne ? `read:${conversationId}` : null, (signal) => getReadCursors(conversationId, signal));
  const [liveCursors, setLiveCursors] = useState<Record<string, string>>({});
  useRealtimeEvent((event) => {
    if (event.type === "readCursor" && event.conversationId === conversationId) {
      setLiveCursors((prev) => ({ ...prev, [event.userId]: event.lastReadMessageId }));
    }
  });
  const seenId = useMemo(() => {
    if (!oneToOne || !me || pending.length > 0) return null;
    const known = (cursors.data ?? []).map((cur) => ({ ...cur, lastReadMessageId: liveCursors[cur.userId] ?? cur.lastReadMessageId }));
    const added = Object.entries(liveCursors)
      .filter(([userId]) => !known.some((cur) => cur.userId === userId))
      .map(([userId, lastReadMessageId]) => ({ userId, lastReadMessageId }));
    return seenMessageId([...known, ...added], messages, me.id);
  }, [oneToOne, me, pending.length, cursors.data, liveCursors, messages]);

  // Reading higher up: what arrives below is counted on a pill rather than scrolled to.
  const [awayFrom, setAwayFrom] = useState<string | null>(null);
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = e.nativeEvent.contentOffset.y;
    if (y > AWAY && awayFrom === null && newest) setAwayFrom(newest);
    else if (y <= AWAY && awayFrom !== null) setAwayFrom(null);
  };
  const newBelow = awayFrom && me ? countNewer(messages, awayFrom, me.id) : 0;
  const toBottom = () => {
    list.current?.scrollToOffset({ offset: 0, animated: true });
    setAwayFrom(null);
  };

  // Newest first, for an inverted list that opens at the bottom; a day's label follows its messages.
  const rows = useMemo(() => {
    const all = [...messages, ...pending.map((row) => row.message)];
    const out: Row[] = [];
    for (let i = all.length - 1; i >= 0; i--) {
      const m = all[i];
      const older = all[i - 1];
      const day = dayKey(m.createdAt, timeZone);
      const sameRun =
        older &&
        older.kind !== "system" &&
        m.kind !== "system" &&
        older.author === m.author &&
        dayKey(older.createdAt, timeZone) === day &&
        Date.parse(m.createdAt) - Date.parse(older.createdAt) < RUN_GAP_MS;
      if (m.id === seenId) out.push({ kind: "seen" });
      out.push({ kind: "message", message: m, head: !sameRun });
      if (m.id === anchor?.id) out.push({ kind: "unread" });
      if (!older || dayKey(older.createdAt, timeZone) !== day) out.push({ kind: "day", day });
    }
    return out;
  }, [messages, pending, timeZone, seenId, anchor]);

  // Open at the "New messages" line when it is further up than the first screen.
  const opened = useRef(false);
  const unreadIndex = rows.findIndex((row) => row.kind === "unread");
  useEffect(() => {
    if (opened.current || rows.length === 0) return;
    opened.current = true;
    if (unreadIndex > 6) list.current?.scrollToIndex({ index: unreadIndex, viewPosition: 1, animated: false });
  }, [rows.length, unreadIndex]);

  const today = dayKey(new Date(), timeZone);

  const join = () => {
    if (!channel) return;
    joinChannel(channel.id).then(onJoined, () => Alert.alert(t("compose.joinFailed")));
  };

  if (!first.data) return <LoadState error={first.error} onRetry={first.reload} />;

  const closed = channel?.type === "archived" ? "archived" : channel?.member === false ? "notMember" : null;

  return (
    <KeyboardArea style={styles.fill}>
      {rows.length === 0 ? (
        <EmptyState icon={MessageSquare} title={t("conversation.empty")} text={t("conversation.emptyHint")} />
      ) : (
      <View style={styles.fill}>
      <FlatList
        ref={list}
        inverted
        data={rows}
        keyExtractor={(row) => (row.kind === "day" ? `day:${row.day}` : row.kind === "message" ? row.message.id : row.kind)}
        onScroll={onScroll}
        scrollEventThrottle={64}
        onScrollToIndexFailed={(info) => {
          list.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
          setTimeout(() => list.current?.scrollToIndex({ index: info.index, viewPosition: 1, animated: false }), 120);
        }}
        onEndReached={() => void loadOlder()}
        onEndReachedThreshold={0.4}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        ListFooterComponent={older.loading ? <ActivityIndicator color={c.ink} style={styles.more} /> : null}
        // The list is inverted: its header is its bottom, some air between the last message and the bar.
        ListHeaderComponent={<View style={styles.end} />}
        renderItem={({ item }) => {
          if (item.kind === "unread") {
            return (
              <View style={styles.day} accessibilityRole="header">
                <View style={[styles.rule, { backgroundColor: c.alarm }]} />
                <Text variant="tiny" style={[styles.unread, { color: c.alarm }]}>
                  {t("conversation.newMessages")}
                </Text>
                <View style={[styles.rule, { backgroundColor: c.alarm }]} />
              </View>
            );
          }
          if (item.kind === "seen") {
            return (
              <View style={styles.seen}>
                <Check size={12} color={c.muted} />
                <Text variant="tiny" tone="muted">
                  {t("conversation.seen")}
                </Text>
              </View>
            );
          }
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
          const local = outbox.byId.get(item.message.id);
          return (
            <MessageRow
              message={item.message}
              head={item.head}
              mentionsMe={!local && myNames.some((n) => body.includes(n))}
              avatar={members.avatarOf(item.message.author)}
              mentionNames={members.mentionNames}
              pending={local?.state}
              onRetry={local ? () => outbox.retry(local.localId) : undefined}
              onDiscard={local ? () => outbox.drop(local.localId) : undefined}
              myUserId={me?.id}
              onLongPress={() =>
                navigation.navigate("messageActions", { conversationId, channelId, title, draftKey: conversationId, message: item.message })
              }
              onOpenThread={() => navigation.navigate("thread", { conversationId, channelId, rootId: item.message.id, title, root: item.message })}
              avatarOf={members.avatarOf}
              onReact={(emoji) => react(conversationId, item.message, emoji)}
              onAddReaction={() => navigation.navigate("emojiPicker", { conversationId, message: item.message })}
            />
          );
        }}
      />
      {newBelow > 0 ? (
        <Pressable
          accessibilityRole="button"
          onPress={toBottom}
          style={({ pressed }) => [styles.pill, { backgroundColor: c.ink, shadowColor: s.shadow }, pressed && { opacity: 0.85 }]}
        >
          <ArrowDown size={16} color={c.onInk} />
          <Text variant="smallStrong" tone="onInk">
            {t("conversation.newBelow", { count: newBelow })}
          </Text>
        </Pressable>
      ) : null}
      </View>
      )}
      {closed ? (
        <SafeAreaView edges={["bottom"]} style={[styles.closed, { borderTopColor: c.line, backgroundColor: c.surface }]}>
          <View style={[styles.closedPill, { backgroundColor: s.sunken }]}>
            <Archive size={16} color={c.muted} />
            <Text variant="small" tone="muted" style={styles.closedText}>
              {closed === "archived" ? t("compose.archived") : t("compose.notMember")}
            </Text>
            {closed === "notMember" ? <Button label={t("compose.join")} size="sm" variant="secondary" onPress={join} /> : null}
          </View>
        </SafeAreaView>
      ) : me ? (
        <Composer
          key={edit.editing ? `edit:${edit.editing.id}` : conversationId}
          conversationId={conversationId}
          draftKey={conversationId}
          placeholder={t("compose.placeholder")}
          people={members.list}
          channels={channels}
          broadcasts={channel !== undefined}
          myUserId={me.id}
          baselineFor={outbox.baselineFor}
          typing={typing}
          editing={edit.editing}
          onSaveEdit={edit.save}
          onCancelEdit={edit.cancel}
          onSent={() => list.current?.scrollToOffset({ offset: 0, animated: true })}
          onAttach={() => navigation.navigate("attachSheet", { draftKey: conversationId })}
          attachments={attachments}
        />
      ) : null}
    </KeyboardArea>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  info: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  tabs: { paddingBottom: 8, borderBottomWidth: hairline },
  more: { padding: 16 },
  end: { height: 12 },
  day: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 10 },
  rule: { flex: 1, height: hairline },
  unread: { fontFamily: fonts.sansSemibold },
  seen: { flexDirection: "row", alignItems: "center", gap: 4, paddingLeft: 62, paddingBottom: 6 },
  pill: {
    position: "absolute",
    bottom: 12,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radius.l,
    shadowOpacity: 0.18,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  closed: { borderTopWidth: hairline, paddingHorizontal: 16, paddingTop: 10 },
  closedPill: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44, paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.m, marginBottom: 6 },
  closedText: { flex: 1 },
});
