import {
  editMessage,
  getChannelMessages,
  getChannels,
  joinChannel,
  listChannelMembers,
  setReadCursor,
  type ApiMessage,
  type Channel,
} from "@ruchoir/client";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import { Archive, CalendarDays, FileText, MessageSquare } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Platform, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Composer, type Editing } from "../../compose/Composer";
import { useAttachRequests, useEditRequests } from "../../compose/requests";
import { useAttachments } from "../../compose/useAttachments";
import { useReact } from "../../compose/useReact";
import { useOutbox } from "../../compose/useOutbox";
import { useTypingUsers } from "../../compose/useTyping";

import { useSpaceMembers } from "../../data/members";
import { useLoad } from "../../data/useLoad";
import { key, useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { dayKey, daysBetween } from "../../logic/format";
import { arrivedIds, pendingRows } from "../../logic/outbox";
import { applyReactionDelta } from "../../logic/reactions";
import type { RootParams } from "../../navigation/types";
import { mergeMessages } from "../../realtime/merge";
import { useRealtimeEvent } from "../../realtime/RealtimeProvider";
import { useSession } from "../../session/SessionProvider";
import { useSpace } from "../../space/SpaceProvider";
import { hairline, radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { Avatar } from "../../ui/Avatar";
import { BackHeader } from "../../ui/BackHeader";
import { Button } from "../../ui/Button";
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
  const channels = useLoad(current ? `channels:${current.id}` : null, (signal) => getChannels(current!.id, signal));
  const channel = params.channelId ? channels.data?.find((ch) => ch.id === params.channelId) : undefined;

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
          <Messages
            conversationId={params.conversationId}
            title={params.title}
            channelId={params.channelId}
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
  /** The channel, for a channel (null while it loads); undefined for a private conversation. */
  channel: Channel | null | undefined;
  channels: Channel[];
  onJoined: () => void;
  members: ReturnType<typeof useSpaceMembers>;
};

function Messages({ conversationId, title, channelId, channel, channels, onJoined, members }: MessagesProps) {
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const { locale, timeZone } = useLocale();
  const { state } = useSession();
  const me = state.kind === "signedIn" ? state.user : null;
  const outbox = useOutbox();
  const navigation = useNavigation();
  const react = useReact();
  const list = useRef<FlatList<Row>>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const first = useLoad(`messages:${conversationId}`, (signal) => getChannelMessages(conversationId, {}, signal));
  const [extra, setExtra] = useState<{ messages: ApiMessage[]; nextBefore?: string; loadingMore: boolean }>({
    messages: [],
    loadingMore: false,
  });
  const messages = useMemo(() => mergeMessages(first.data?.messages ?? [], extra.messages), [first.data, extra.messages]);
  const nextBefore = extra.nextBefore ?? first.data?.nextBefore;

  // Change one message on screen from its latest copy (the live one if there is one).
  const firstPage = first.data?.messages;
  const patch = useCallback(
    (id: string, change: (m: ApiMessage) => ApiMessage) =>
      setExtra((prev) => {
        const current = prev.messages.find((m) => m.id === id) ?? firstPage?.find((m) => m.id === id);
        return current ? { ...prev, messages: mergeMessages(prev.messages, [change(current)]) } : prev;
      }),
    [firstPage],
  );

  // Live: a message here is merged in, and an edit, a deletion, a reaction or a pin changes the copy
  // on screen. My own changes arrive as patches, before the server confirms them.
  useRealtimeEvent((event) => {
    if (event.type === "message" && event.conversationId === conversationId) {
      setExtra((prev) => ({ ...prev, messages: mergeMessages(prev.messages, [event.message]) }));
    } else if (event.type === "patched" && event.conversationId === conversationId) {
      patch(event.message.id, () => event.message);
    } else if (event.type === "reaction" && event.conversationId === conversationId && event.userId !== me?.id) {
      const name = members.list.find((m) => m.userId === event.userId)?.name ?? t("message.someone");
      patch(event.messageId, (m) => {
        const reactions = applyReactionDelta(m.reactions, event.emoji, event.added, name);
        return { ...m, reactions: reactions.length > 0 ? reactions : undefined };
      });
    } else if (event.type === "pinned" && event.conversationId === conversationId) {
      patch(event.messageId, (m) => ({ ...m, pinned: event.pinned || undefined }));
    }
  });

  // "Edit" in the message's sheet puts its text back in the composer.
  useEditRequests(conversationId, (request) => setEditing({ id: request.id, body: request.body }));

  // Files picked in the attach sheet start uploading at once, above the bar.
  const attachments = useAttachments(conversationId);
  useAttachRequests(conversationId, (request) => {
    if (request.kind === "local") void attachments.add(request.files);
    else attachments.addSpaceFile(request.file);
  });

  // My messages on their way. One that already arrived (live, or after a lost answer) is done.
  const mine = useMemo(
    () => outbox.items.filter((i) => i.conversationId === conversationId && i.parentId === undefined),
    [outbox.items, conversationId],
  );
  const arrived = useMemo(() => (me ? arrivedIds(mine, messages, me.id) : new Map<string, string>()), [mine, messages, me]);
  const { settle } = outbox;
  useEffect(() => {
    if (arrived.size > 0) settle([...arrived.keys()]);
  }, [arrived, settle]);
  const pending = useMemo(
    () => (me ? pendingRows(mine, conversationId, undefined, me).filter((row) => !arrived.has(row.localId)) : []),
    [mine, conversationId, me, arrived],
  );
  const pendingById = useMemo(() => new Map(pending.map((row) => [row.message.id, row])), [pending]);

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
      out.push({ kind: "message", message: m, head: !sameRun });
      if (!older || dayKey(older.createdAt, timeZone) !== day) out.push({ kind: "day", day });
    }
    return out;
  }, [messages, pending, timeZone]);

  const myNames = useMemo(() => {
    if (!me) return [];
    const words = me.name.split(/\s+/).filter(Boolean);
    return [me.name, words[0], words.join("")].map((n) => `@${n}`.toLowerCase());
  }, [me]);
  const today = dayKey(new Date(), timeZone);

  const typingIds = useTypingUsers(conversationId, me?.id);
  const typing = useMemo(() => {
    const names = typingIds.map((id) => members.list.find((m) => m.userId === id)?.name).filter((n): n is string => !!n);
    if (names.length === 0) return undefined;
    if (names.length === 1) return t("compose.typingOne", { name: names[0] });
    if (names.length === 2) return t("compose.typingTwo", { a: names[0], b: names[1] });
    return t("compose.typingMany");
  }, [typingIds, members.list, t]);

  const baselineFor = useCallback(
    (body: string) => (me ? messages.filter((m) => m.authorId === me.id && m.body.trim() === body).map((m) => m.id) : []),
    [messages, me],
  );

  // An edit shows at once; if the server refuses it, the old text comes back and the edit can resume.
  const saveEdit = useCallback(
    (id: string, body: string) => {
      setEditing(null);
      const before = messages.find((m) => m.id === id);
      if (!before || before.body.trim() === body) return;
      const files = [...(before.attachments ?? []), ...(before.images ?? [])].flatMap((f) => (f.fileId ? [f.fileId] : []));
      setExtra((prev) => ({ ...prev, messages: mergeMessages(prev.messages, [{ ...before, body, edited: true }]) }));
      editMessage(id, body, files).then(
        (saved) => setExtra((prev) => ({ ...prev, messages: mergeMessages(prev.messages, [saved]) })),
        () => {
          setExtra((prev) => ({ ...prev, messages: mergeMessages(prev.messages, [before]) }));
          Alert.alert(t("compose.editFailed"), t("compose.editFailedText"), [
            { text: t("common.retry"), onPress: () => setEditing({ id, body }) },
            { text: t("compose.ok"), style: "cancel" },
          ]);
        },
      );
    },
    [messages, t],
  );

  const join = () => {
    if (!channel) return;
    joinChannel(channel.id).then(onJoined, () => Alert.alert(t("compose.joinFailed")));
  };

  if (!first.data) return <LoadState error={first.error} onRetry={first.reload} />;

  const closed = channel?.type === "archived" ? "archived" : channel?.member === false ? "notMember" : null;

  return (
    <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      {rows.length === 0 ? (
        <EmptyState icon={MessageSquare} title={t("conversation.empty")} text={t("conversation.emptyHint")} />
      ) : (
      <FlatList
        ref={list}
        inverted
        data={rows}
        keyExtractor={(row) => (row.kind === "day" ? `day:${row.day}` : row.message.id)}
        onEndReached={() => void loadOlder()}
        onEndReachedThreshold={0.4}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
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
          const local = pendingById.get(item.message.id);
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
              onLongPress={() => navigation.navigate("messageActions", { conversationId, channelId, message: item.message })}
              onReact={(emoji) => react(conversationId, item.message, emoji)}
              onAddReaction={() => navigation.navigate("emojiPicker", { conversationId, message: item.message })}
            />
          );
        }}
      />
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
          key={editing ? `edit:${editing.id}` : conversationId}
          conversationId={conversationId}
          draftKey={conversationId}
          placeholder={channel !== undefined ? t("compose.placeholderChannel", { name: title }) : t("compose.placeholderPerson", { name: title })}
          people={members.list}
          channels={channels}
          broadcasts={channel !== undefined}
          myUserId={me.id}
          baselineFor={baselineFor}
          typing={typing}
          editing={editing}
          onSaveEdit={saveEdit}
          onCancelEdit={() => setEditing(null)}
          onSent={() => list.current?.scrollToOffset({ offset: 0, animated: true })}
          onAttach={() => navigation.navigate("attachSheet", { draftKey: conversationId })}
          attachments={attachments}
        />
      ) : null}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  tabs: { paddingBottom: 8, borderBottomWidth: hairline },
  more: { padding: 16 },
  day: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 10 },
  rule: { flex: 1, height: hairline },
  closed: { borderTopWidth: hairline, paddingHorizontal: 16, paddingTop: 10 },
  closedPill: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44, paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.m, marginBottom: 6 },
  closedText: { flex: 1 },
});
