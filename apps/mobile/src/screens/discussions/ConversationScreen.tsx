import type { ApiMessage, Channel } from "@ruchoir/client";
import { useNavigation, useRoute, type NavigationProp, type RouteProp } from "@react-navigation/native";
import { Archive, ArrowDown, CalendarDays, CheckCheck, ChevronLeft, FileText, Info, MessageSquare, Pin } from "lucide-react-native";
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

import { useApi } from "../../api/useApi";
import { Composer } from "../../compose/Composer";
import { useAttachRequests } from "../../compose/requests";
import { useAttachments } from "../../compose/useAttachments";
import { useReact } from "../../compose/useReact";
import { useSpaceMembers } from "../../data/members";
import { useLoad } from "../../data/useLoad";
import { useTabletLayout, useWide } from "../../layout/useWide";
import { readNotificationsOf } from "../../data/readNotifications";
import { deletedHere } from "./deletedHere";
import { key, useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { dayKey, daysBetween } from "../../logic/format";
import { readReceipt, receiptWording } from "../../logic/receipts";
import { seekMessage } from "../../logic/seek";
import { countNewer, firstUnreadId } from "../../logic/unread";
import type { RootParams } from "../../navigation/types";
import { useReloadOn } from "../../data/useReloadOn";
import { useRealtimeActions, useRealtimeEvent } from "../../realtime/RealtimeProvider";
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
import { useToast } from "../../ui/Toast";
import { affects } from "../../realtime/events";
import { ConversationAgenda } from "./ConversationAgenda";
import { ConversationFiles } from "./ConversationFiles";
import { ConversationPins } from "./ConversationPins";
import { useEditing, useLiveMessages, useMyMentions, useOutboxRows, useTypingLine } from "./feed";
import { MessageRow } from "./MessageRow";

type Pane = "messages" | "files" | "pinned" | "agenda";
/** The tabs of a conversation; the pinned messages and the agenda belong to a channel only. */
const PANES = [
  { key: "messages", label: key("conversation.messages"), icon: MessageSquare, channelOnly: false },
  { key: "files", label: key("tabs.files"), icon: FileText, channelOnly: false },
  { key: "pinned", label: key("conversation.pinned"), icon: Pin, channelOnly: true },
  { key: "agenda", label: key("tabs.agenda"), icon: CalendarDays, channelOnly: true },
] as const;

/** Two messages by one person less than five minutes apart read as one block. */
const RUN_GAP_MS = 5 * 60 * 1000;

type Row =
  | { kind: "message"; message: ApiMessage; head: boolean }
  | { kind: "day"; day: string }
  | { kind: "unread" }
  | { kind: "seen"; readers: string[] };

const isInFeed = (m: ApiMessage) => !m.parentId;

/** A message of the feed to take the reader to; `replyId` when what was asked for is one of its replies. */
type Focus = { id: string; replyId?: string; n: number };

/** How far up (in points) the reader has to be for new messages to be announced rather than seen. */
const AWAY = 240;

/** A conversation (mockup 13): its messages live, its files and, for a channel, its events. */
export function ConversationScreen() {
  const { params } = useRoute<RouteProp<RootParams, "conversation">>();
  const wide = useWide();
  const navigation = useNavigation<NavigationProp<RootParams>>();
  // On a tablet a conversation opens in the Discussions tab, beside the list (the tablet mockups),
  // wherever it was asked for: Today, a search, a notification, a link.
  useEffect(() => {
    if (!wide) return;
    navigation.goBack();
    navigation.navigate("tabs", { screen: "discussions", params: { open: params } });
  }, [wide, navigation, params]);
  if (wide) return null;
  return <ConversationView params={params} />;
}

/**
 * The conversation itself, pushed (`ConversationScreen`) or beside the list on a tablet
 * (`DiscussionsScreen`): there, `onClose` empties the pane where a pushed one goes back, and its head
 * has no arrow. What it opens (a thread, a message's sheet, the details) goes over the whole app.
 */
export function ConversationView({ params, onClose }: { params: RootParams["conversation"]; onClose?: () => void }) {
  const { getChannels, listChannelMembers } = useApi();
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const tablet_ = useTabletLayout();
  const { current } = useSpace();
  const members = useSpaceMembers(current?.id);
  const [pane, setPane] = useState<Pane>("messages");
  // A message asked for from the pinned tab: the feed takes the reader there (its root, for a reply),
  // then lets go of it, so coming back to the messages later does not jump again.
  // A search result opens the conversation at its message.
  const [focus, setFocus] = useState<Focus | null>(params.focus ? { ...params.focus, n: 1 } : null);
  const focusTaken = useCallback(() => setFocus(null), []);
  const openPinned = (m: ApiMessage) => {
    setFocus((prev) => ({ id: m.parentId ?? m.id, replyId: m.parentId ? m.id : undefined, n: (prev?.n ?? 0) + 1 }));
    setPane("messages");
  };
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
  // A channel renamed elsewhere shows its new name.
  const title = channel?.name ?? params.title;
  const navigation = useNavigation();
  const toast = useToast();
  // The channel and its people as they change elsewhere; a channel deleted while open says so and goes.
  useReloadOn((e) => !!current && affects.channels(e, current.id), channels.reload);
  useReloadOn((e) => !!params.channelId && affects.channelMembers(e, params.channelId), channelMembers.reload);
  const session = useSession();
  const myId = session.state.kind === "signedIn" ? session.state.user.id : null;
  const leave = onClose ?? (() => navigation.goBack());
  useRealtimeEvent((e) => {
    if (e.type !== "channels" || !params.channelId || e.channelId !== params.channelId) return;
    if (e.deleted) {
      // Deleted from this phone: the details page has already taken the person back to the list.
      if (deletedHere.has(params.channelId)) {
        onClose?.();
        return;
      }
      toast(t("conversation.channelGone"));
      leave();
    } else if (e.membership?.change === "removed" && e.membership.userId === myId) {
      toast(t("conversation.removedFromChannel"));
      leave();
    }
  });
  const openDetails = () =>
    navigation.navigate("conversationDetails", { conversationId: params.conversationId, channelId: params.channelId, title });

  const tablet = onClose ? tablet_ : null;
  const panes = PANES.filter((p) => !p.channelOnly || params.channelId);
  const face = group ? (
    <AvatarStack
      size={tablet ? 44 : 36}
      people={group.map((id) => {
        const member = members.list.find((m) => m.userId === id);
        return { name: member?.name ?? "", avatarUrl: member?.avatarUrl };
      })}
    />
  ) : (
    <Avatar
      name={params.title}
      kind={params.channelId ? "workspace" : "person"}
      src={params.channelId ? undefined : members.avatarOf(params.title)}
      size={tablet ? 44 : 36}
    />
  );

  return (
    <SafeAreaView edges={["top"]} style={styles.fill}>
      {tablet ? (
        // The tablet mockups' head (02, 10): 76 high, a larger face and name; held wide, the panes as
        // pills beside them; upright, the way back to the list first.
        <View style={[styles.wideHead, { borderBottomColor: c.line, backgroundColor: c.surface, paddingLeft: tablet === "portrait" ? 12 : 28 }]}>
          {tablet === "portrait" ? (
            <Pressable accessibilityRole="button" accessibilityLabel={t("conversation.backToList")} onPress={onClose} style={({ pressed }) => [styles.wideBack, pressed && { opacity: 0.6 }]}>
              <ChevronLeft size={24} color={c.ink} />
              <Text style={[styles.wideBackText, { color: c.ink }]}>{t("tabs.discussions")}</Text>
            </Pressable>
          ) : null}
          <Pressable accessibilityRole="button" onPress={openDetails} style={styles.wideWho}>
            {face}
            <View style={styles.wideTitles}>
              <Text style={[styles.wideTitle, { color: c.ink }]} numberOfLines={1}>
                {title}
              </Text>
              {subtitle ? (
                <Text style={[styles.wideSub, { color: c.muted }]} numberOfLines={1}>
                  {subtitle}
                </Text>
              ) : null}
            </View>
          </Pressable>
          {tablet === "landscape" ? (
            <View style={styles.widePills}>
              {panes.map((p) => {
                const on = pane === p.key;
                const Icon = p.icon;
                return (
                  <Pressable
                    key={p.key}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: on }}
                    onPress={() => setPane(p.key)}
                    style={[styles.widePill, { borderColor: on ? c.ink : c.lineStrong, backgroundColor: on ? s.selected : c.surface }]}
                  >
                    <Icon size={16} color={c.ink} />
                    <Text variant="smallStrong" style={{ color: c.ink }}>
                      {t(p.label)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}
          <Pressable accessibilityRole="button" accessibilityLabel={t("details.open")} onPress={openDetails} style={({ pressed }) => [styles.wideInfo, pressed && { opacity: 0.6 }]}>
            <Info size={22} color={c.body} />
          </Pressable>
        </View>
      ) : (
      <BackHeader
        title={title}
        subtitle={subtitle}
        back={!onClose}
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
        leading={face}
      />
      )}
      {tablet === "landscape" ? null : (
        <View style={[styles.tabs, { borderBottomColor: c.line }]}>
          <Chips chips={panes.map((p) => ({ key: p.key, label: t(p.label), icon: p.icon }))} value={pane} onChange={setPane} />
        </View>
      )}
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
            focus={focus}
            onFocusTaken={focusTaken}
          />
        ) : pane === "files" ? (
          <ConversationFiles conversationId={params.conversationId} />
        ) : pane === "pinned" ? (
          <ConversationPins channelId={params.channelId!} title={title} onOpen={openPinned} />
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
  focus: Focus | null;
  onFocusTaken: () => void;
};

function Messages({ conversationId, title, channelId, unread, oneToOne, channel, channels, onJoined, members, focus, onFocusTaken }: MessagesProps) {
  const api = useApi();
  const { getChannelMessages, getReadCursors, joinChannel, setReadCursor } = api;
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const tabletLayout = useTabletLayout();
  const { locale, timeZone } = useLocale();
  const { state } = useSession();
  const me = state.kind === "signedIn" ? state.user : null;
  const navigation = useNavigation();
  const react = useReact();
  const { emit } = useRealtimeActions();
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
    void setReadCursor(conversationId, newest).then(
      () => readNotificationsOf(api, conversationId, emit).catch(() => {}),
      () => {
        marked.current = null;
      },
    );
  }, [conversationId, newest, emit, setReadCursor, api]);

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
  }, [nextBefore, older.loading, getChannelMessages, conversationId, add]);

  // Where the unread messages started when the conversation opened: the line stays there while reading.
  const [anchor, setAnchor] = useState<{ id: string | null } | null>(null);
  if (anchor === null && first.data && me) setAnchor({ id: firstUnreadId(first.data.messages, unread ?? 0, me.id) });

  // "Seen" or "Read by ..." under my last message, from the read cursors.
  const cursors = useLoad(`read:${conversationId}`, (signal) => getReadCursors(conversationId, signal));
  const [liveCursors, setLiveCursors] = useState<Record<string, string>>({});
  useRealtimeEvent((event) => {
    if (event.type === "readCursor" && event.conversationId === conversationId) {
      setLiveCursors((prev) => ({ ...prev, [event.userId]: event.lastReadMessageId }));
    }
  });
  const receipt = useMemo(() => {
    if (!me || pending.length > 0) return null;
    const known = (cursors.data ?? []).map((cur) => ({ ...cur, lastReadMessageId: liveCursors[cur.userId] ?? cur.lastReadMessageId }));
    const added = Object.entries(liveCursors)
      .filter(([userId]) => !known.some((cur) => cur.userId === userId))
      .map(([userId, lastReadMessageId]) => ({ userId, lastReadMessageId }));
    const found = readReceipt([...known, ...added], messages, me.id);
    return found && found.readers.length > 0 ? found : null;
  }, [me, pending.length, cursors.data, liveCursors, messages]);
  // Who could read it, me aside: the other person, a channel's members, a group's participants.
  const audience = oneToOne
    ? 1
    : channel
      ? Math.max((channel.memberCount ?? 1) - 1, 1)
      : Math.max((cursors.data ?? []).filter((cur) => cur.userId !== me?.id).length, 1);
  const nameOf = (userId: string) => members.list.find((m) => m.userId === userId)?.name ?? "?";

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
      if (m.id === receipt?.id) out.push({ kind: "seen", readers: receipt.readers });
      out.push({ kind: "message", message: m, head: !sameRun });
      if (m.id === anchor?.id) out.push({ kind: "unread" });
      if (!older || dayKey(older.createdAt, timeZone) !== day) out.push({ kind: "day", day });
    }
    return out;
  }, [messages, pending, timeZone, receipt, anchor]);

  // Where a scroll to a row puts it: the unread line at the top of the screen, a message asked for in
  // the middle. Read again when the row was not drawn yet (`onScrollToIndexFailed`).
  const scrollPosition = useRef(1);

  // Open at the "New messages" line when it is further up than the first screen, unless the reader
  // came for a given message.
  const opened = useRef(false);
  const unreadIndex = rows.findIndex((row) => row.kind === "unread");
  const cameFor = focus !== null;
  useEffect(() => {
    if (opened.current || rows.length === 0) return;
    opened.current = true;
    if (cameFor) return;
    if (unreadIndex > 6) list.current?.scrollToIndex({ index: unreadIndex, viewPosition: 1, animated: false });
  }, [rows.length, unreadIndex, cameFor]);

  // Taken to a message from the pinned tab: scrolled to and lit, once older pages are fetched when it
  // is further up than what is loaded; a reply opens its thread over its root.
  const toast = useToast();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [flash, setFlash] = useState<string | null>(null);
  const [seeking, setSeeking] = useState(false);
  const wanted = useRef<Focus | null>(null);
  const handled = useRef(0);
  const seek = useCallback(
    async (target: Focus) => {
      handled.current = target.n;
      wanted.current = target;
      onFocusTaken();
      setSeeking(true);
      setOlder((prev) => ({ ...prev, loading: true }));
      const result = await seekMessage((before) => getChannelMessages(conversationId, { before, limit: 100 }), nextBefore, target.id).catch(
        () => null,
      );
      if (!alive.current) return;
      setSeeking(false);
      setOlder((prev) => ({ nextBefore: result ? result.nextBefore : prev.nextBefore, loading: false }));
      if (result) add(result.messages);
      if (result?.found) return;
      wanted.current = null;
      toast(result ? t("conversation.messageNotFound") : t("load.failed"), "failure");
    },
    [onFocusTaken, nextBefore, add, toast, t, getChannelMessages, conversationId],
  );
  useEffect(() => {
    if (!first.data) return;
    if (focus && focus.n !== handled.current) {
      if (!rows.some((row) => row.kind === "message" && row.message.id === focus.id)) {
        // Further up than what is loaded: fetched first, started out of the effect.
        const timer = setTimeout(() => void seek(focus), 0);
        return () => clearTimeout(timer);
      }
      handled.current = focus.n;
      wanted.current = focus;
      onFocusTaken();
    }
    const want = wanted.current;
    if (!want) return;
    const index = rows.findIndex((row) => row.kind === "message" && row.message.id === want.id);
    const row = rows[index];
    if (row?.kind !== "message") return;
    wanted.current = null;
    scrollPosition.current = 0.5;
    list.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true });
    setFlash(want.id);
    if (want.replyId) {
      navigation.navigate("thread", { conversationId, channelId, rootId: want.id, title, root: row.message, focusId: want.replyId });
    }
  }, [focus, rows, first.data, seek, navigation, conversationId, channelId, title, onFocusTaken]);
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), 2000);
    return () => clearTimeout(timer);
  }, [flash]);

  const today = dayKey(new Date(), timeZone);

  const join = () => {
    if (!channel) return;
    joinChannel(channel.id).then(onJoined, () => Alert.alert(t("compose.joinFailed")));
  };

  if (!first.data) return <LoadState error={first.error} onRetry={first.reload} />;

  const closed = channel?.type === "archived" ? "archived" : channel?.member === false ? "notMember" : null;

  return (
    <KeyboardArea composer slide={rows.length > 0} style={styles.fill}>
      {rows.length === 0 ? (
        <EmptyState icon={MessageSquare} title={t("conversation.empty")} text={t("conversation.emptyHint")} />
      ) : (
      <View style={styles.fill}>
      <FlatList
        ref={list}
        // A tablet reads in a column 820 wide at most, in the middle (the tablet mockups).
        style={tabletLayout ? styles.wideColumn : undefined}
        inverted
        data={rows}
        keyExtractor={(row) => (row.kind === "day" ? `day:${row.day}` : row.kind === "message" ? row.message.id : row.kind)}
        onScroll={onScroll}
        scrollEventThrottle={64}
        onScrollToIndexFailed={(info) => {
          list.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
          setTimeout(() => list.current?.scrollToIndex({ index: info.index, viewPosition: scrollPosition.current, animated: false }), 120);
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
            const wording = receiptWording(item.readers.length, audience);
            const [first, second] = item.readers.map(nameOf);
            return (
              <View style={styles.seen}>
                <CheckCheck size={12} color={c.muted} />
                <Text variant="tiny" tone="muted" numberOfLines={1} style={styles.shrink}>
                  {wording === "read"
                    ? t("conversation.seen")
                    : wording === "everyone"
                      ? t("conversation.readByEveryone")
                      : wording === "one"
                        ? t("conversation.readByOne", { name: first })
                        : wording === "two"
                          ? t("conversation.readByTwo", { first, second })
                          : t("conversation.readBySome", { count: item.readers.length, audience })}
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
              highlighted={flash === item.message.id}
            />
          );
        }}
      />
      {seeking ? (
        <View style={[styles.seeking, { backgroundColor: c.surface, borderColor: c.line, shadowColor: s.shadow }]}>
          <ActivityIndicator color={c.ink} />
        </View>
      ) : null}
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
  // The tablet mockups' conversation head.
  wideHead: { flexDirection: "row", alignItems: "center", gap: 14, minHeight: 76, paddingRight: 20, borderBottomWidth: hairline },
  wideBack: { height: 44, flexDirection: "row", alignItems: "center", gap: 2, paddingLeft: 2, paddingRight: 8 },
  wideBackText: { fontSize: 15, lineHeight: 20, fontFamily: fonts.sansSemibold },
  wideWho: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 14 },
  wideTitles: { flex: 1, minWidth: 0, gap: 2 },
  wideTitle: { fontSize: 22, lineHeight: 28, fontFamily: fonts.sansBold, letterSpacing: -0.5 },
  wideSub: { fontSize: 14, lineHeight: 19, fontFamily: fonts.sans },
  widePills: { flexDirection: "row", gap: 8 },
  widePill: { height: 36, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 14, borderRadius: 999, borderWidth: hairline },
  wideInfo: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  wideColumn: { width: "100%", maxWidth: 820 + 32, alignSelf: "center" },
  info: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  tabs: { paddingBottom: 8, borderBottomWidth: hairline },
  more: { padding: 16 },
  end: { height: 12 },
  day: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 10 },
  rule: { flex: 1, height: hairline },
  unread: { fontFamily: fonts.sansSemibold },
  seen: { flexDirection: "row", alignItems: "center", gap: 4, paddingLeft: 62, paddingBottom: 6 },
  shrink: { flexShrink: 1 },
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
  // Fetching older pages for a message asked for: a round badge at the top of the feed.
  seeking: {
    position: "absolute",
    top: 12,
    alignSelf: "center",
    padding: 10,
    borderRadius: radius.l,
    borderWidth: hairline,
    shadowOpacity: 0.18,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  closed: { borderTopWidth: hairline, paddingHorizontal: 16, paddingTop: 10 },
  closedPill: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44, paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.m, marginBottom: 6 },
  closedText: { flex: 1 },
});
