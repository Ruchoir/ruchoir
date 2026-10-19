import { getChannels, getDirectMessages, type Member } from "@ruchoir/client";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import { Lock, MessageCircle, MessageSquare, SearchX, SquarePen, Users } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from "react-native";

import { useSpaceMembers } from "../../data/members";
import { useLoad } from "../../data/useLoad";
import { useReloadOn } from "../../data/useReloadOn";
import { key, useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { useTabletLayout } from "../../layout/useWide";
import { buildConversations, listConversations, withLivePresence, type ConversationFilter, type ConversationItem } from "../../logic/conversations";
import { affects } from "../../realtime/events";
import { useRealtimeEvent } from "../../realtime/RealtimeProvider";
import { listStamp } from "../../logic/format";
import type { RootParams, TabParams } from "../../navigation/types";
import { fonts } from "../../theme/fonts";
import { useSpace } from "../../space/SpaceProvider";
import { hairline, radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { Avatar } from "../../ui/Avatar";
import { AvatarStack } from "../../ui/AvatarStack";
import { Badge } from "../../ui/Badge";
import { Chips } from "../../ui/Chips";
import { feel } from "../../ui/haptics";
import { SearchField } from "../../ui/SearchField";
import { FloatingButton, useFloatingScroll } from "../../ui/FloatingButton";
import { EmptyState, LoadState } from "../../ui/States";
import { SpaceSwitch, TabHeader } from "../../ui/TabHeader";
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
  const tablet = useTabletLayout();
  const wide = tablet !== null;
  const { current } = useSpace();
  const route = useRoute<RouteProp<TabParams, "discussions">>();
  // The conversation beside the list, in the space it was opened in: another space starts empty.
  const [opened, setOpened] = useState<{ spaceId: string; params: RootParams["conversation"] } | null>(null);
  const beside = wide && opened && opened.spaceId === current?.id ? opened.params : null;
  // A conversation asked for elsewhere (Today, a search, a notification) opens here on a tablet.
  const asked = route.params?.open;
  const [taken, setTaken] = useState<typeof asked>(undefined);
  if (asked && asked !== taken && current) {
    setTaken(asked);
    setOpened({ spaceId: current.id, params: asked });
  }
  useEffect(() => {
    if (asked) navigation.setParams({ open: undefined } as never);
  }, [asked, navigation]);
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
    <TabScreen color={wide ? c.surface : undefined}>
      {wide ? (
        // The tablet mockups' head: the title, the space under it, and "New message" beside them.
        <View style={styles.wideHead}>
          <View style={styles.wideTitles}>
            <Text style={[styles.wideTitle, { color: c.ink }]}>{t("tabs.discussions")}</Text>
            <SpaceSwitch />
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("newMessage.title")}
            onPress={() => navigation.navigate("newMessage")}
            style={({ pressed }) => [styles.compose, { borderColor: c.acc, backgroundColor: c.surface, shadowColor: c.acc }, pressed && { opacity: 0.7 }]}
          >
            <SquarePen size={20} color={c.ink} />
          </Pressable>
        </View>
      ) : (
        <TabHeader title={t("tabs.discussions")} />
      )}
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
          <View style={[styles.top, wide && styles.topWide]}>
            <SearchField value={query} onChange={setQuery} placeholder={t("discussions.search")} style={wide ? styles.wideGutter : undefined} />
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
            memberOf={memberOf}
            selected={beside?.conversationId === item.id}
            onPress={() => open(item)}
            variant={wide ? "tablet" : "phone"}
          />
        )}
        extraData={beside?.conversationId}
        // Room under the last row for the floating button.
        contentContainerStyle={[styles.list, wide && styles.listWide]}
      />
      {wide ? null : (
        <FloatingButton compact={floating.compact} icon={SquarePen} label={t("newMessage.title")} onPress={() => navigation.navigate("newMessage")} />
      )}
    </TabScreen>
  );
  if (!wide) return list;
  const conversation = beside ? <ConversationView key={beside.conversationId} params={beside} onClose={() => setOpened(null)} /> : null;
  // Upright, one at a time (tablet mockup 10): the list, or the conversation with its way back.
  if (tablet === "portrait") return <View style={[styles.fill, { backgroundColor: c.bg }]}>{conversation ?? list}</View>;
  return (
    <View style={[styles.split, { backgroundColor: c.bg }]}>
      <View style={[styles.side, { borderRightColor: c.line, backgroundColor: c.surface }]}>{list}</View>
      <View style={styles.pane}>{conversation ?? <PickOne />}</View>
    </View>
  );
}

/** No conversation open beside the list yet (tablet mockup 02). */
function PickOne() {
  const { t } = useTranslation();
  const { c } = useTheme();
  return (
    <View style={styles.pick}>
      <View style={[styles.pickTile, { backgroundColor: c.sky }]}>
        <MessageSquare size={32} color={c.onPastel} />
      </View>
      <Text style={[styles.pickTitle, { color: c.ink }]}>{t("discussions.pick")}</Text>
      <Text style={[styles.pickText, { color: c.muted }]}>{t("discussions.pickHint")}</Text>
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
  variant = "phone",
}: {
  item: ConversationItem;
  onPress: () => void;
  memberOf?: (userId: string) => Member | undefined;
  /** The one open beside the list (a tablet). */
  selected?: boolean;
  /** The tablet mockups' row: rounded, a larger face, two lines (what it is goes unsaid). */
  variant?: "phone" | "tablet";
}) {
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const { locale, timeZone } = useLocale();
  const tablet = variant === "tablet";
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
        tablet && styles.rowTablet,
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
          size={tablet ? 46 : 44}
          presence={item.kind === "person" ? item.presence : undefined}
        />
      )}
      <View style={styles.body}>
        <View style={styles.line}>
          <Text variant="bodyStrong" numberOfLines={1} style={[styles.name, tablet && [styles.nameTablet, { fontFamily: item.unread > 0 ? fonts.sansBold : fonts.sansSemibold }]]}>
            {item.name}
          </Text>
          {stamp ? (
            <Text variant="tiny" tone="muted" style={tablet ? styles.timeTablet : undefined}>
              {stamp.kind === "yesterday" ? t("time.yesterday") : stamp.text}
            </Text>
          ) : null}
        </View>
        {/* Nothing said yet: no empty line under the name. */}
        {preview || item.unread > 0 ? (
          <View style={styles.line}>
            <Text variant="small" tone={item.unread > 0 ? "strong" : "muted"} numberOfLines={1} style={[styles.name, tablet && styles.previewTablet]}>
              {preview ?? ""}
            </Text>
            <Badge count={item.unread} tone={item.kind === "channel" ? "accent" : "ink"} />
          </View>
        ) : null}
        {/* What it is: a group (a channel, with a lock when it is on invitation) or a private
            conversation with several people; a conversation with one person needs no line. */}
        {tablet ? null : item.kind === "channel" ? (
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
  fill: { flex: 1 },
  split: { flex: 1, flexDirection: "row" },
  // The tablet mockups' list: 24/20/12 around its head, a title of 32, the rows inset by 8.
  wideHead: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingTop: 24, paddingHorizontal: 20, paddingBottom: 12 },
  wideTitles: { flex: 1, minWidth: 0, gap: 2 },
  wideTitle: { fontSize: 32, lineHeight: 38, fontFamily: fonts.sansBold, letterSpacing: -1.1 },
  compose: {
    marginTop: 4,
    width: 48,
    height: 48,
    borderRadius: radius.m,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
    shadowOffset: { width: 3, height: 3 },
    shadowOpacity: 1,
    shadowRadius: 0,
    elevation: 3,
  },
  topWide: { paddingTop: 0, paddingBottom: 4 },
  wideGutter: { marginHorizontal: 20 },
  listWide: { paddingHorizontal: 8, paddingBottom: 16 },
  rowTablet: { paddingHorizontal: 12, paddingVertical: 10, borderRadius: radius.m },
  nameTablet: { fontSize: 16, lineHeight: 21 },
  timeTablet: { fontSize: 13, lineHeight: 17 },
  previewTablet: { fontSize: 14, lineHeight: 19 },
  pick: { flex: 1, alignItems: "center", justifyContent: "center", gap: 14, padding: 40 },
  pickTile: { width: 72, height: 72, borderRadius: radius.l, alignItems: "center", justifyContent: "center" },
  pickTitle: { fontSize: 22, lineHeight: 28, fontFamily: fonts.sansBold, textAlign: "center" },
  pickText: { fontSize: 15, lineHeight: 21, maxWidth: 320, textAlign: "center" },
  side: { width: 380, borderRightWidth: hairline },
  pane: { flex: 1, justifyContent: "center" },
  list: { paddingBottom: 88 },
  // The tab's head stays above the list (it does not scroll away); the gap it had below it, here.
  top: { gap: 12, paddingTop: 12, paddingBottom: 8 },
  row: { flexDirection: "row", gap: 12, paddingHorizontal: 16, paddingVertical: 10, alignItems: "flex-start" },
  single: { alignItems: "center" },
  body: { flex: 1, minWidth: 0, gap: 2 },
  line: { flexDirection: "row", alignItems: "center", gap: 8 },
  name: { flex: 1, minWidth: 0 },
  meta: { flexDirection: "row", alignItems: "center", gap: 4 },
});
