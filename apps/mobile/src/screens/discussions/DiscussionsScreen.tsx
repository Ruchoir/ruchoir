import { getChannels, getDirectMessages, type Member } from "@ruchoir/client";
import { useNavigation } from "@react-navigation/native";
import { Lock, MessageCircle, MessageSquare, SearchX, SquarePen, Users } from "lucide-react-native";
import { useCallback, useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from "react-native";

import { useSpaceMembers } from "../../data/members";
import { useLoad } from "../../data/useLoad";
import { useReloadOn } from "../../data/useReloadOn";
import { key, useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { useWide } from "../../layout/useWide";
import { buildConversations, listConversations, withLivePresence, type ConversationFilter, type ConversationItem } from "../../logic/conversations";
import { affects } from "../../realtime/events";
import { useRealtimeEvent } from "../../realtime/RealtimeProvider";
import { listStamp } from "../../logic/format";
import type { RootParams } from "../../navigation/types";
import { useSpace } from "../../space/SpaceProvider";
import { hairline } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { Avatar } from "../../ui/Avatar";
import { AvatarStack } from "../../ui/AvatarStack";
import { Badge } from "../../ui/Badge";
import { Chips } from "../../ui/Chips";
import { feel } from "../../ui/haptics";
import { SearchField } from "../../ui/SearchField";
import { FloatingButton, useFloatingScroll } from "../../ui/FloatingButton";
import { EmptyState, LoadState } from "../../ui/States";
import { TabHeader } from "../../ui/TabHeader";
import { TabScreen } from "../../ui/TabScreen";
import { Text } from "../../ui/Text";
import { ConversationView } from "./ConversationScreen";
import { SYSTEM_TEXT } from "./systemText";

const FILTERS = [
  { key: "all", label: key("discussions.filterAll") },
  { key: "unread", label: key("discussions.filterUnread") },
  { key: "groups", label: key("discussions.filterGroups") },
  { key: "people", label: key("discussions.filterPeople") },
] as const;

/** The space's channels and direct conversations, each with its latest message as the lists carry it. */
export async function loadConversations(spaceId: string, signal: AbortSignal): Promise<ConversationItem[]> {
  const [channels, dms] = await Promise.all([getChannels(spaceId, signal), getDirectMessages(spaceId, signal)]);
  return buildConversations(channels, dms);
}

/**
 * The space's conversations (mockup 12), refreshing themselves as messages arrive. On a wide window
 * (a tablet) the list keeps the left and the conversation tapped opens beside it, rather than over it.
 */
export function DiscussionsScreen() {
  const { t } = useTranslation();
  const { c } = useTheme();
  const navigation = useNavigation();
  const wide = useWide();
  const { current } = useSpace();
  // The conversation beside the list, in the space it was opened in: another space starts empty.
  const [opened, setOpened] = useState<{ spaceId: string; params: RootParams["conversation"] } | null>(null);
  const beside = wide && opened && opened.spaceId === current?.id ? opened.params : null;
  const [filter, setFilter] = useState<ConversationFilter>("all");
  const [query, setQuery] = useState("");
  const floating = useFloatingScroll();
  const conversations = useLoad(current ? `conversations:${current.id}` : null, (signal) =>
    loadConversations(current!.id, signal),
  );
  const memberOf = useMemberOf(current?.id);

  // A new message moves a conversation up and changes its preview; a channel, a name or a face changes
  // its row. Who is online moves without any of that: it is laid over the rows as it is heard.
  const spaceId = current?.id ?? "";
  useReloadOn((e) => affects.conversations(e, spaceId), conversations.reload);
  const pulled = () => {
    feel("refresh");
    conversations.reload();
  };
  const [presence, setPresence] = useState<Record<string, ConversationItem["presence"]>>({});
  useRealtimeEvent((e) => {
    if (e.type === "presence") setPresence((now) => ({ ...now, [e.userId]: e.presence }));
  });

  const items = useMemo(
    () => (conversations.data ? withLivePresence(listConversations(conversations.data, filter, query), presence) : []),
    [conversations.data, filter, query, presence],
  );
  const unreadCount = conversations.data?.filter((c) => c.unread > 0).length ?? 0;
  const open = (item: ConversationItem) => {
    const params = {
      conversationId: item.id,
      title: item.name,
      channelId: item.kind === "channel" ? item.id : undefined,
      unread: item.unread,
      kind: item.kind,
      participants: item.participants,
    };
    if (wide && current) setOpened({ spaceId: current.id, params });
    else navigation.navigate("conversation", params);
  };

  const list = (
    <TabScreen>
      <FlatList
        onScroll={floating.onScroll}
        scrollEventThrottle={floating.scrollEventThrottle}
        data={items}
        // While searching, the last rows can still be scrolled above the keyboard.
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        keyExtractor={(c) => c.id}
        refreshControl={<RefreshControl refreshing={false} onRefresh={pulled} />}
        ListHeaderComponent={
          <View style={styles.top}>
            <TabHeader title={t("tabs.discussions")} />
            <SearchField value={query} onChange={setQuery} placeholder={t("discussions.search")} />
            <Chips
              chips={FILTERS.map((f) => ({ key: f.key, label: t(f.label), count: f.key === "unread" ? unreadCount : undefined }))}
              value={filter}
              onChange={setFilter}
            />
          </View>
        }
        ListEmptyComponent={
          !conversations.data ? (
            <LoadState error={conversations.error} onRetry={conversations.reload} />
          ) : (
            query ? (
              <EmptyState size="compact" icon={SearchX} title={t("discussions.noMatch")} text={t("search.tryAnother")} />
            ) : (
              <EmptyState icon={MessageSquare} title={t("discussions.empty")} text={t("discussions.emptyHint")} />
            )
          )
        }
        renderItem={({ item }) => (
          <ConversationRow item={item} memberOf={memberOf} selected={beside?.conversationId === item.id} onPress={() => open(item)} />
        )}
        extraData={beside?.conversationId}
        // Room under the last row for the floating button.
        contentContainerStyle={styles.list}
      />
      <FloatingButton compact={floating.compact} icon={SquarePen} label={t("newMessage.title")} onPress={() => navigation.navigate("newMessage")} />
    </TabScreen>
  );
  if (!wide) return list;
  return (
    <View style={[styles.split, { backgroundColor: c.bg }]}>
      <View style={[styles.side, { borderRightColor: c.line }]}>{list}</View>
      <View style={styles.pane}>
        {beside ? (
          <ConversationView key={beside.conversationId} params={beside} onClose={() => setOpened(null)} />
        ) : (
          <EmptyState icon={MessageSquare} title={t("discussions.pick")} text={t("discussions.pickHint")} />
        )}
      </View>
    </View>
  );
}

/** The space's people by id, for the faces of a private conversation with several of them. */
export function useMemberOf(spaceId: string | undefined): (userId: string) => Member | undefined {
  const members = useSpaceMembers(spaceId);
  const byId = useMemo(() => new Map(members.list.map((m) => [m.userId, m])), [members.list]);
  return useCallback((userId: string) => byId.get(userId), [byId]);
}

export function ConversationRow({
  item,
  onPress,
  memberOf,
  selected = false,
}: {
  item: ConversationItem;
  onPress: () => void;
  memberOf?: (userId: string) => Member | undefined;
  /** The one open beside the list (a tablet). */
  selected?: boolean;
}) {
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const { locale, timeZone } = useLocale();
  const stamp = item.at ? listStamp(item.at, new Date(), locale, timeZone) : null;
  const p = item.preview;
  // What was said (or, a message of files only, that it carried files), then by whom; a notice is
  // a sentence of its own ("Alice shared an event: Planning").
  const said = p ? (p.files ? t("discussions.files") : p.text) : "";
  const preview = !p
    ? null
    : p.notice
      ? p.notice.event
        ? t(SYSTEM_TEXT[p.notice.event], { who: p.notice.who?.split(" ")[0] ?? t("message.someone"), detail: p.text })
        : p.text || null
      : p.mine
        ? t("discussions.you", { text: said })
        : p.author
          ? t("discussions.by", { who: p.author.split(" ")[0], text: said })
          : said;

  return (
    <Pressable
      onPress={onPress}
      accessibilityState={{ selected }}
      style={({ pressed }) => [
        styles.row,
        !preview && item.kind === "person" && styles.single,
        selected && { backgroundColor: s.selected },
        pressed && { backgroundColor: c.line },
      ]}
    >
      {item.kind === "group" && item.participants ? (
        <AvatarStack
          people={item.participants.map((id) => {
            const member = memberOf?.(id);
            return { name: member?.name ?? "", avatarUrl: member?.avatarUrl };
          })}
        />
      ) : (
        <Avatar
          name={item.name}
          kind={item.kind === "person" ? "person" : "workspace"}
          src={item.kind === "person" && item.userId ? memberOf?.(item.userId)?.avatarUrl : undefined}
          size={44}
          presence={item.kind === "person" ? item.presence : undefined}
        />
      )}
      <View style={styles.body}>
        <View style={styles.line}>
          <Text variant="bodyStrong" numberOfLines={1} style={styles.name}>
            {item.name}
          </Text>
          {stamp ? (
            <Text variant="tiny" tone="muted">
              {stamp.kind === "yesterday" ? t("time.yesterday") : stamp.text}
            </Text>
          ) : null}
        </View>
        {/* Nothing said yet: no empty line under the name. */}
        {preview || item.unread > 0 ? (
          <View style={styles.line}>
            <Text variant="small" tone={item.unread > 0 ? "strong" : "muted"} numberOfLines={1} style={styles.name}>
              {preview ?? ""}
            </Text>
            <Badge count={item.unread} tone={item.kind === "channel" ? "accent" : "ink"} />
          </View>
        ) : null}
        {/* What it is: a group (a channel, with a lock when it is on invitation) or a private
            conversation with several people; a conversation with one person needs no line. */}
        {item.kind === "channel" ? (
          <View style={styles.meta}>
            {item.private ? <Lock size={12} color={c.muted} /> : <Users size={12} color={c.muted} />}
            <Text variant="tiny" tone="muted">
              {item.private
                ? item.members !== undefined
                  ? t("discussions.privateGroupOf", { count: item.members })
                  : t("discussions.privateGroup")
                : item.members !== undefined
                  ? t("discussions.groupOf", { count: item.members })
                  : t("discussions.group")}
            </Text>
          </View>
        ) : item.kind === "group" ? (
          <View style={styles.meta}>
            <MessageCircle size={12} color={c.muted} />
            <Text variant="tiny" tone="muted">
              {item.members !== undefined ? t("discussions.conversationOf", { count: item.members }) : t("newMessage.personHint")}
            </Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  split: { flex: 1, flexDirection: "row" },
  side: { width: 380, borderRightWidth: hairline },
  pane: { flex: 1, justifyContent: "center" },
  list: { paddingBottom: 88 },
  top: { gap: 12, paddingBottom: 8 },
  row: { flexDirection: "row", gap: 12, paddingHorizontal: 16, paddingVertical: 10, alignItems: "flex-start" },
  single: { alignItems: "center" },
  body: { flex: 1, minWidth: 0, gap: 2 },
  line: { flexDirection: "row", alignItems: "center", gap: 8 },
  name: { flex: 1, minWidth: 0 },
  meta: { flexDirection: "row", alignItems: "center", gap: 4 },
});
