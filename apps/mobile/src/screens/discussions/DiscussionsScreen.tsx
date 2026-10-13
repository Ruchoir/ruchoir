import { getChannelMessages, getChannels, getDirectMessages } from "@ruchoir/client";
import { useNavigation } from "@react-navigation/native";
import { MessageSquare, SearchX, Users } from "lucide-react-native";
import { useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from "react-native";

import { useLoad } from "../../data/useLoad";
import { useReloadOn } from "../../data/useReloadOn";
import { key, useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { buildConversations, listConversations, type ConversationFilter, type ConversationItem } from "../../logic/conversations";
import { listStamp } from "../../logic/format";
import { useSpace } from "../../space/SpaceProvider";
import { useTheme } from "../../theme/useTheme";
import { Avatar } from "../../ui/Avatar";
import { Badge } from "../../ui/Badge";
import { Chips } from "../../ui/Chips";
import { SearchField } from "../../ui/SearchField";
import { EmptyState, LoadState } from "../../ui/States";
import { NoSpace } from "../../ui/NoSpace";
import { TabHeader } from "../../ui/TabHeader";
import { TabScreen } from "../../ui/TabScreen";
import { Text } from "../../ui/Text";

const FILTERS = [
  { key: "all", label: key("discussions.filterAll") },
  { key: "unread", label: key("discussions.filterUnread") },
  { key: "groups", label: key("discussions.filterGroups") },
  { key: "people", label: key("discussions.filterPeople") },
] as const;

/**
 * The space's conversations (mockup 12). Channels carry no preview of their own, so the latest
 * message of each is read alongside; the list refreshes itself as messages arrive.
 */
export async function loadConversations(spaceId: string, signal: AbortSignal): Promise<ConversationItem[]> {
  const [channels, dms] = await Promise.all([getChannels(spaceId, signal), getDirectMessages(spaceId, signal)]);
  const mine = channels.filter((c) => c.member !== false);
  const pages = await Promise.all(
    mine.map((c) => getChannelMessages(c.id, { limit: 1 }, signal).catch(() => ({ messages: [] }))),
  );
  const latest = Object.fromEntries(mine.map((c, i) => [c.id, pages[i].messages[pages[i].messages.length - 1]]));
  return buildConversations(channels, dms, latest);
}

export function DiscussionsScreen() {
  const { t } = useTranslation();
  const navigation = useNavigation();
  const { current, status } = useSpace();
  const [filter, setFilter] = useState<ConversationFilter>("all");
  const [query, setQuery] = useState("");
  const conversations = useLoad(current ? `conversations:${current.id}` : null, (signal) =>
    loadConversations(current!.id, signal),
  );

  // A new message moves a conversation up and changes its preview.
  useReloadOn((e) => e.type === "message" || e.type === "readCursor" || e.type === "channels", conversations.reload);

  const items = useMemo(
    () => (conversations.data ? listConversations(conversations.data, filter, query) : []),
    [conversations.data, filter, query],
  );
  const unreadCount = conversations.data?.filter((c) => c.unread > 0).length ?? 0;

  if (status === "none") return <NoSpace title={t("tabs.discussions")} />;

  return (
    <TabScreen>
      <FlatList
        data={items}
        keyExtractor={(c) => c.id}
        refreshControl={<RefreshControl refreshing={false} onRefresh={conversations.reload} />}
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
          <ConversationRow
            item={item}
            onPress={() =>
              navigation.navigate("conversation", {
                conversationId: item.id,
                title: item.name,
                channelId: item.kind === "channel" ? item.id : undefined,
                unread: item.unread,
                kind: item.kind,
              })
            }
          />
        )}
      />
    </TabScreen>
  );
}

export function ConversationRow({ item, onPress }: { item: ConversationItem; onPress: () => void }) {
  const { t } = useTranslation();
  const { c } = useTheme();
  const { locale, timeZone } = useLocale();
  const stamp = item.at ? listStamp(item.at, new Date(), locale, timeZone) : null;
  const preview = item.preview
    ? item.preview.mine
      ? t("discussions.you", { text: item.preview.text })
      : item.preview.author
        ? t("discussions.by", { who: item.preview.author.split(" ")[0], text: item.preview.text })
        : item.preview.text
    : null;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, !preview && item.kind !== "group" && styles.single, pressed && { backgroundColor: c.line }]}
    >
      <Avatar name={item.name} kind={item.kind === "person" ? "person" : "workspace"} size={44} presence={item.kind === "person" ? item.presence : undefined} />
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
        <View style={styles.line}>
          <Text variant="small" tone={item.unread > 0 ? "strong" : "muted"} numberOfLines={1} style={styles.name}>
            {preview ?? ""}
          </Text>
          <Badge count={item.unread} tone={item.kind === "channel" ? "accent" : "ink"} />
        </View>
        {item.kind === "group" ? (
          <View style={styles.meta}>
            <Users size={12} color={c.muted} />
            <Text variant="tiny" tone="muted">
              {t("discussions.group")}
            </Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  top: { gap: 12, paddingBottom: 8 },
  row: { flexDirection: "row", gap: 12, paddingHorizontal: 16, paddingVertical: 10, alignItems: "flex-start" },
  single: { alignItems: "center" },
  body: { flex: 1, minWidth: 0, gap: 2 },
  line: { flexDirection: "row", alignItems: "center", gap: 8 },
  name: { flex: 1, minWidth: 0 },
  meta: { flexDirection: "row", alignItems: "center", gap: 4 },
});
