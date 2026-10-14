/**
 * A thread: the message it answers on top, "3 replies", the replies, and the composer to answer in
 * it. Live like the conversation: a reply arriving shows here, and only here.
 */
import { getChannels, getReplies, type ApiMessage } from "@ruchoir/client";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import { useCallback, useMemo } from "react";
import { FlatList, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Composer } from "../../compose/Composer";
import { useAttachRequests } from "../../compose/requests";
import { useAttachments } from "../../compose/useAttachments";
import { useReact } from "../../compose/useReact";
import { useSpaceMembers } from "../../data/members";
import { useLoad } from "../../data/useLoad";
import { useReloadOn } from "../../data/useReloadOn";
import { affects } from "../../realtime/events";
import { useTranslation } from "../../i18n";
import type { RootParams } from "../../navigation/types";
import { useSession } from "../../session/SessionProvider";
import { useSpace } from "../../space/SpaceProvider";
import { hairline } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { BackHeader } from "../../ui/BackHeader";
import { LoadState } from "../../ui/States";
import { Text } from "../../ui/Text";
import { KeyboardArea } from "../../ui/KeyboardArea";
import { useEditing, useLiveMessages, useMyMentions, useOutboxRows, useTypingLine } from "./feed";
import { MessageRow } from "./MessageRow";

/** Two replies by one person less than five minutes apart read as one block, as in the conversation. */
const RUN_GAP_MS = 5 * 60 * 1000;

type Row = { kind: "message"; message: ApiMessage; head: boolean; root?: boolean } | { kind: "count"; count: number };

export function ThreadScreen() {
  const { params } = useRoute<RouteProp<RootParams, "thread">>();
  const { conversationId, channelId, rootId, title } = params;
  const { t } = useTranslation();
  const { c } = useTheme();
  const { state } = useSession();
  const me = state.kind === "signedIn" ? state.user : null;
  const navigation = useNavigation();
  const react = useReact();
  const { current } = useSpace();
  const members = useSpaceMembers(current?.id);
  const channels = useLoad(current ? `channels:${current.id}` : null, (signal) => getChannels(current!.id, signal));
  useReloadOn((e) => !!current && affects.channels(e, current.id), channels.reload);
  const draftKey = `thread:${rootId}`;

  const replies = useLoad(`replies:${rootId}`, (signal) => getReplies(rootId, signal));
  const loaded = useMemo(
    () => (replies.data ? [...(params.root ? [params.root] : []), ...replies.data] : undefined),
    [replies.data, params.root],
  );
  const belongs = useCallback((m: ApiMessage) => m.id === rootId || m.parentId === rootId, [rootId]);
  const { messages, patch } = useLiveMessages(conversationId, loaded, belongs, me, members.list);
  const outbox = useOutboxRows(conversationId, rootId, messages, me);
  const edit = useEditing(draftKey, messages, patch);
  const typing = useTypingLine(conversationId, me, members.list);
  const myNames = useMyMentions(me);

  const attachments = useAttachments(conversationId);
  useAttachRequests(draftKey, (request) => {
    if (request.kind === "local") void attachments.add(request.files);
    else attachments.addSpaceFile(request.file);
  });

  // Newest first for an inverted list: the replies (mine on their way last), the count, the root.
  const rows = useMemo(() => {
    const root = messages.find((m) => m.id === rootId);
    const answers = [...messages.filter((m) => m.id !== rootId), ...outbox.pending.map((row) => row.message)];
    const out: Row[] = [];
    for (let i = answers.length - 1; i >= 0; i--) {
      const m = answers[i];
      const older = answers[i - 1];
      const sameRun = older && older.author === m.author && Date.parse(m.createdAt) - Date.parse(older.createdAt) < RUN_GAP_MS;
      out.push({ kind: "message", message: m, head: !sameRun });
    }
    out.push({ kind: "count", count: answers.length });
    if (root) out.push({ kind: "message", message: root, head: true, root: true });
    return out;
  }, [messages, outbox.pending, rootId]);

  return (
    <SafeAreaView edges={["top"]} style={styles.fill}>
      <BackHeader title={t("thread.title")} subtitle={t("thread.in", { name: channelId ? `#${title}` : title })} />
      <KeyboardArea composer slide={!!replies.data} style={[styles.fill, { borderTopWidth: hairline, borderTopColor: c.line }]}>
        {!replies.data ? (
          <LoadState error={replies.error} onRetry={replies.reload} />
        ) : (
          <FlatList
            inverted
            // The list is inverted: its header is its bottom, some air between the last reply and the bar.
            ListHeaderComponent={<View style={styles.end} />}
            data={rows}
            keyExtractor={(row) => (row.kind === "count" ? "count" : row.message.id)}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => {
              if (item.kind === "count") {
                return (
                  <View style={styles.count}>
                    <Text variant="tiny" tone="muted">
                      {item.count > 0 ? t("message.replies", { count: item.count }) : t("thread.noReplies")}
                    </Text>
                    <View style={[styles.rule, { backgroundColor: c.line }]} />
                  </View>
                );
              }
              const m = item.message;
              const local = outbox.byId.get(m.id);
              const body = m.body.toLowerCase();
              return (
                <MessageRow
                  message={m}
                  head={item.head}
                  mentionsMe={!local && myNames.some((n) => body.includes(n))}
                  avatar={members.avatarOf(m.author)}
                  mentionNames={members.mentionNames}
                  pending={local?.state}
                  onRetry={local ? () => outbox.retry(local.localId) : undefined}
                  onDiscard={local ? () => outbox.drop(local.localId) : undefined}
                  myUserId={me?.id}
                  onLongPress={() =>
                    navigation.navigate("messageActions", { conversationId, channelId, title, draftKey, inThread: true, message: m })
                  }
                  onReact={(emoji) => react(conversationId, m, emoji)}
                  onAddReaction={() => navigation.navigate("emojiPicker", { conversationId, message: m })}
                />
              );
            }}
          />
        )}
        {me ? (
          <Composer
            key={edit.editing ? `edit:${edit.editing.id}` : draftKey}
            conversationId={conversationId}
            draftKey={draftKey}
            parentId={rootId}
            placeholder={t("compose.placeholderThread")}
            people={members.list}
            channels={channels.data ?? []}
            broadcasts={!!channelId}
            myUserId={me.id}
            baselineFor={outbox.baselineFor}
            typing={typing}
            editing={edit.editing}
            onSaveEdit={edit.save}
            onCancelEdit={edit.cancel}
            onAttach={() => navigation.navigate("attachSheet", { draftKey })}
            attachments={attachments}
          />
        ) : null}
      </KeyboardArea>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  end: { height: 12 },
  count: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 10 },
  rule: { flex: 1, height: hairline },
});
