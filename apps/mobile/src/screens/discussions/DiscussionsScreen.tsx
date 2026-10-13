import { getChannels, getDirectMessages } from "@ruchoir/client";
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
import { NewMessageButton } from "./NewMessageButton";
import { SYSTEM_TEXT } from "./systemText";

const FILTERS = [
  { key: "all", label: key("discussions.filterAll") },
  { key: "unread", label: key("discussions.filterUnread") },
  { key: "groups", label: key("discussions.filterGroups") },
  { key: "people", label: key("discussions.filterPeople") },
] as const;

/**
 * The space's conversations (mockup 12): channels and direct conversations, each with its latest
 * message as the lists carry it. The list refreshes itself as messages arrive.
 */
export async function loadConversations(spaceId: string, signal: AbortSignal): Promise<ConversationItem[]> {
  const [channels, dms] = await Promise.all([getChannels(spaceId, signal), getDirectMessages(spaceId, signal)]);
  return buildConversations(channels, dms);
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
        // Room under the last row for the floating button.
        contentContainerStyle={styles.list}
      />
      <NewMessageButton onPress={() => navigation.navigate("newMessage")} />
    </TabScreen>
  );
}

export function ConversationRow({ item, onPress }: { item: ConversationItem; onPress: () => void }) {
  const { t } = useTranslation();
  const { c } = useTheme();
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
        ? t(SYSTEM_TEXT[p.notice.event], { who: p.notice.who ?? t("message.someone"), detail: p.text })
        : p.text || null
      : p.mine
        ? t("discussions.you", { text: said })
        : p.author
          ? t("discussions.by", { who: p.author.split(" ")[0], text: said })
          : said;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, !preview && item.kind === "person" && styles.single, pressed && { backgroundColor: c.line }]}
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
        {item.kind !== "person" ? (
          <View style={styles.meta}>
            <Users size={12} color={c.muted} />
            <Text variant="tiny" tone="muted">
              {item.members !== undefined ? t("discussions.groupOf", { count: item.members }) : t("discussions.group")}
            </Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  list: { paddingBottom: 88 },
  top: { gap: 12, paddingBottom: 8 },
  row: { flexDirection: "row", gap: 12, paddingHorizontal: 16, paddingVertical: 10, alignItems: "flex-start" },
  single: { alignItems: "center" },
  body: { flex: 1, minWidth: 0, gap: 2 },
  line: { flexDirection: "row", alignItems: "center", gap: 8 },
  name: { flex: 1, minWidth: 0 },
  meta: { flexDirection: "row", alignItems: "center", gap: 4 },
});
