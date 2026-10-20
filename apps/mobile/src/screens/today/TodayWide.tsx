import { fileDownloadUrl, getChannelMessages, respondToEvent, type ApiNotification, type CalendarColor, type Member, type Occurrence, type SpaceFile } from "@ruchoir/client";
import { useNavigation, type NavigationProp } from "@react-navigation/native";
import { AtSign, CalendarDays, CalendarPlus, Folder, Search, Sparkles } from "lucide-react-native";
import { useEffect, useState, type ReactNode } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";

import { useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { dayStamp, timeOf } from "../../logic/format";
import type { ConversationItem } from "../../logic/conversations";
import type { RootParams } from "../../navigation/types";
import { fonts } from "../../theme/fonts";
import { hairline, mix, radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { Button } from "../../ui/Button";
import { FileIcon } from "../../ui/FileIcon";
import { EmptyState } from "../../ui/States";
import { SpaceSwitch } from "../../ui/TabHeader";
import { InboxBell } from "./InboxBell";
import { TabScreen } from "../../ui/TabScreen";
import { Text } from "../../ui/Text";
import { useToast } from "../../ui/Toast";
import { calendarColor } from "../agenda/calendarColor";
import { ConversationRow } from "../discussions/DiscussionsScreen";

type Props = {
  date: string;
  hello: string;
  /** How many notifications are unread, on the bell. */
  unread: number;
  mention?: ApiNotification;
  /** Today's timed occurrences still to come or under way, in order. */
  events: Occurrence[];
  colors: Map<string, CalendarColor | undefined>;
  files: SpaceFile[];
  conversations: ConversationItem[];
  memberOf: (userId: string) => Member | undefined;
  myUserId?: string;
  onRefresh: () => void;
  openConversation: (item: ConversationItem) => void;
  openNotification: (n: ApiNotification) => void;
  /** The mention card's title ("Léa vous a mentionné"). */
  mentionTitle: (n: ApiNotification) => string;
};

/**
 * Today on a tablet (tablet mockups 01 and 11): the date, the greeting and the space, the search of
 * the whole space beside them; then two columns, what to look at now and the latest conversations on
 * the left, today's events and the latest files on the right. A window too narrow for two columns
 * of 340 points (a tablet upright) stacks them, the left one first.
 */
export function TodayWide(props: Props) {
  const { t } = useTranslation();
  const { c } = useTheme();
  const navigation = useNavigation<NavigationProp<RootParams>>();
  const [width, setWidth] = useState(0);
  // The mockup's grid: columns of at least 340 points, 24 apart, in a page 1040 wide at most.
  const two = width >= 340 * 2 + 24;
  const left = (
    <View style={styles.column}>
      <View style={styles.nowBlock}>
        <Text style={[styles.sectionTitle, { color: c.ink }]}>{t("today.now")}</Text>
        {props.mention ? (
          <MentionCard n={props.mention} title={props.mentionTitle(props.mention)} myUserId={props.myUserId} onOpen={() => props.openNotification(props.mention!)} />
        ) : (
          <View style={[styles.card, { borderColor: c.lineStrong, backgroundColor: c.surface }]}>
            <EmptyState size="compact" icon={Sparkles} title={t("today.calm")} text={t("today.calmHint")} />
          </View>
        )}
      </View>
      <Card title={t("today.recent")} action={{ label: t("today.seeAll"), onPress: () => navigation.navigate("tabs", { screen: "discussions" }) }}>
        {props.conversations.map((item) => (
          <ConversationRow key={item.id} item={item} memberOf={props.memberOf} onPress={() => props.openConversation(item)} />
        ))}
      </Card>
    </View>
  );
  const right = (
    <View style={styles.column}>
      <Card
        title={t("time.today")}
        tile={{ icon: CalendarDays, color: c.sky }}
        action={{ label: t("today.seeAgenda"), onPress: () => navigation.navigate("tabs", { screen: "agenda" }) }}
      >
        <View style={styles.events}>
          {props.events.map((o) => (
            <EventRow key={`${o.eventId}:${o.start}`} occurrence={o} color={calendarColor(props.colors.get(o.calendarId), c)} />
          ))}
          <Pressable
            accessibilityRole="button"
            onPress={() => navigation.navigate("eventForm", {})}
            style={({ pressed }) => [styles.ghost, pressed && { backgroundColor: c.line }]}
          >
            <CalendarPlus size={18} color={c.ink} />
            <Text variant="smallStrong">{t("calendar.newEvent")}</Text>
          </Pressable>
        </View>
      </Card>
      <Card
        title={t("today.latestFiles")}
        tile={{ icon: Folder, color: c.peach }}
        action={{ label: t("today.seeAll"), onPress: () => navigation.navigate("tabs", { screen: "files" }) }}
      >
        {props.files.map((file) => (
          <FileRowWide key={file.id ?? file.name} file={file} />
        ))}
        {props.files.length === 0 ? (
          <Text variant="small" tone="muted" style={styles.none}>
            {t("today.noFiles")}
          </Text>
        ) : null}
      </Card>
    </View>
  );

  return (
    <TabScreen>
      <ScrollView contentContainerStyle={styles.scroll} refreshControl={<RefreshControl refreshing={false} onRefresh={props.onRefresh} />}>
        <View style={styles.page} onLayout={(e) => setWidth(e.nativeEvent.layout.width - 88)}>
          <View style={[styles.head, !two && styles.headStacked]}>
            <View style={styles.titles}>
              <Text style={[styles.date, { color: c.muted }]}>{props.date}</Text>
              <Text style={[styles.hello, { color: c.ink }]} numberOfLines={1}>
                {props.hello}
              </Text>
              <SpaceSwitch />
            </View>
            <InboxBell unread={props.unread} />
            <Pressable
              accessibilityRole="search"
              accessibilityLabel={t("search.everywhere")}
              onPress={() => navigation.navigate("search")}
              style={({ pressed }) => [styles.search, { borderColor: c.controlLine, backgroundColor: c.surface }, pressed && { opacity: 0.7 }]}
            >
              <Search size={18} color={c.muted} />
              <Text tone="muted" style={styles.searchText}>
                {t("search.everywhere")}
              </Text>
            </Pressable>
          </View>
          {two ? (
            <View style={styles.columns}>
              {left}
              {right}
            </View>
          ) : (
            <View style={styles.column}>
              {left}
              {right}
            </View>
          )}
        </View>
      </ScrollView>
    </TabScreen>
  );
}

/** A card of the mockup: a title (with its coloured tile), a link on the right, its rows. */
function Card({
  title,
  tile,
  action,
  children,
}: {
  title: string;
  tile?: { icon: typeof Folder; color: string };
  action?: { label: string; onPress: () => void };
  children: ReactNode;
}) {
  const { c } = useTheme();
  const Icon = tile?.icon;
  return (
    <View style={[styles.card, { borderColor: c.lineStrong, backgroundColor: c.surface }]}>
      <View style={[styles.cardHead, tile && styles.cardHeadTile]}>
        <View style={styles.cardTitle}>
          {Icon ? (
            <View style={[styles.tile, { backgroundColor: tile!.color }]}>
              <Icon size={18} color={c.onPastel} />
            </View>
          ) : null}
          <Text style={[styles.cardTitleText, { color: c.ink }]}>{title}</Text>
        </View>
        {action ? <Button variant="link" size="sm" label={action.label} onPress={action.onPress} /> : null}
      </View>
      {children}
      <View style={styles.cardFoot} />
    </View>
  );
}

/**
 * What to look at now: who addressed the reader, the words, where and when; the conversation opens
 * from it, and an invitation it carries is answered from it ("Yes, I will be there").
 */
function MentionCard({ n, title, myUserId, onOpen }: { n: ApiNotification; title: string; myUserId?: string; onOpen: () => void }) {
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const { locale, timeZone } = useLocale();
  const toast = useToast();
  const where = n.channelName ? t("today.inChannel", { name: n.channelName }) : t("today.direct");
  // The event the message invites the reader to, when it carries one: found among the latest messages.
  const [event, setEvent] = useState<{ id: string; status?: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    getChannelMessages(n.conversationId, { limit: 50 }, controller.signal).then(
      (page) => {
        const card = page.messages.find((m) => m.id === n.messageId)?.eventCard;
        if (card && card.organizerId !== myUserId) setEvent({ id: card.eventId, status: card.myStatus });
      },
      () => {},
    );
    return () => controller.abort();
  }, [n.conversationId, n.messageId, myUserId]);
  const accept = () => {
    if (!event) return;
    setEvent({ ...event, status: "accepted" });
    respondToEvent(event.id, "accepted").then(
      () => toast(t("today.accepted"), "success"),
      () => {
        setEvent(event);
        toast(t("event.answerFailed"), "failure");
      },
    );
  };
  return (
    <View style={[styles.mention, { borderColor: c.ink, backgroundColor: c.surface, shadowColor: s.shadow }]}>
      <View style={styles.mentionTop}>
        <View style={[styles.mentionIcon, { backgroundColor: c.acc }]}>
          <AtSign size={24} color={c.onPastel} />
        </View>
        <View style={styles.mentionText}>
          <Text style={[styles.mentionTitle, { color: c.ink }]}>{title}</Text>
          {n.preview ? <Text style={[styles.quote, { color: c.body }]}>{t("today.quote", { text: n.preview })}</Text> : null}
          <Text style={[styles.meta, { color: c.muted }]}>{`${where} · ${timeOf(n.createdAt, locale, timeZone)}`}</Text>
        </View>
      </View>
      <View style={styles.mentionActions}>
        {event && event.status !== "accepted" ? <Button variant="secondary" size="md" label={t("today.willBeThere")} onPress={accept} /> : null}
        <Button variant="ghost" size="md" label={t("today.openConversation")} onPress={onOpen} />
      </View>
    </View>
  );
}

/** One of today's events: tinted with its calendar's colour, the time in mono, title and place. */
function EventRow({ occurrence: o, color }: { occurrence: Occurrence; color: string }) {
  const { c } = useTheme();
  const { locale, timeZone } = useLocale();
  const navigation = useNavigation<NavigationProp<RootParams>>();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => navigation.navigate("eventSummary", { eventId: o.eventId, recurrenceId: o.recurrenceId, start: o.start })}
      style={({ pressed }) => [
        styles.event,
        { backgroundColor: mix(color, c.surface, 0.24), borderColor: mix(color, c.surface, 0.7) },
        pressed && { opacity: 0.75 },
      ]}
    >
      <View style={[styles.eventBar, { backgroundColor: color }]} />
      <Text style={[styles.eventTime, { color: c.ink }]}>{timeOf(o.start, locale, timeZone)}</Text>
      <View style={styles.eventText}>
        <Text style={[styles.eventTitle, { color: c.ink }]} numberOfLines={1}>
          {o.title}
        </Text>
        {o.location ? (
          <Text style={[styles.meta, { color: c.muted }]} numberOfLines={1}>
            {o.location}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/** A latest file: its icon, its name, who touched it and when. */
function FileRowWide({ file }: { file: SpaceFile }) {
  const { t } = useTranslation();
  const { c } = useTheme();
  const { locale, timeZone } = useLocale();
  const navigation = useNavigation<NavigationProp<RootParams>>();
  const stamp = file.updatedAt ? dayStamp(file.updatedAt, new Date(), locale, timeZone) : null;
  const when = !stamp ? null : stamp.kind === "today" ? t("files.today") : stamp.kind === "yesterday" ? t("files.yesterday") : stamp.text;
  const meta = [file.modifiedBy ?? file.by, when].filter(Boolean).join(" · ");
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() =>
        file.id &&
        navigation.navigate("fileViewer", {
          file: { id: file.id, name: file.name, url: fileDownloadUrl(file.id), mime: file.mimeType, sizeBytes: file.sizeBytes },
        })
      }
      style={({ pressed }) => [styles.fileRow, pressed && { backgroundColor: c.line }]}
    >
      <FileIcon name={file.name} mime={file.mimeType} size={38} />
      <View style={styles.eventText}>
        <Text style={[styles.fileName, { color: c.ink }]} numberOfLines={1} ellipsizeMode="middle">
          {file.name}
        </Text>
        {meta ? <Text style={[styles.meta, { color: c.muted }]}>{meta}</Text> : null}
      </View>
    </Pressable>
  );
}

// The tablet mockups' measures: a page 1040 wide at most, 36/44/48 around it, 28 between blocks.
const styles = StyleSheet.create({
  scroll: { flexGrow: 1 },
  page: { width: "100%", maxWidth: 1040, alignSelf: "center", paddingTop: 36, paddingHorizontal: 44, paddingBottom: 48, gap: 28 },
  head: { flexDirection: "row", alignItems: "flex-end", gap: 24 },
  headStacked: { flexDirection: "column", alignItems: "stretch" },
  titles: { flex: 1, minWidth: 260, gap: 4 },
  date: { fontSize: 15, lineHeight: 20, fontFamily: fonts.sansMedium },
  hello: { fontSize: 40, lineHeight: 48, fontFamily: fonts.sansBold, letterSpacing: -1.4 },
  search: { width: 340, maxWidth: "100%", minHeight: 46, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, borderRadius: radius.m, borderWidth: hairline },
  searchText: { fontSize: 15 },
  columns: { flexDirection: "row", gap: 24, alignItems: "flex-start" },
  column: { flex: 1, minWidth: 0, gap: 24 },
  nowBlock: { gap: 12 },
  sectionTitle: { fontSize: 22, lineHeight: 28, fontFamily: fonts.sansBold, letterSpacing: -0.5 },
  card: { borderRadius: radius.l, borderWidth: hairline, overflow: "hidden" },
  cardHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingTop: 16, paddingHorizontal: 20, paddingBottom: 8 },
  cardHeadTile: { paddingBottom: 10 },
  cardTitle: { flexDirection: "row", alignItems: "center", gap: 10 },
  cardTitleText: { fontSize: 17, lineHeight: 22, fontFamily: fonts.sansBold },
  cardFoot: { height: 8 },
  tile: { width: 36, height: 36, borderRadius: radius.m, alignItems: "center", justifyContent: "center" },
  mention: {
    gap: 16,
    padding: 22,
    borderRadius: radius.l,
    borderWidth: 2,
    shadowOffset: { width: 3, height: 3 },
    shadowOpacity: 1,
    shadowRadius: 0,
    elevation: 3,
  },
  mentionTop: { flexDirection: "row", gap: 16, alignItems: "flex-start" },
  mentionIcon: { width: 52, height: 52, borderRadius: radius.m, alignItems: "center", justifyContent: "center" },
  mentionText: { flex: 1, minWidth: 0, gap: 6 },
  mentionTitle: { fontSize: 17, lineHeight: 22, fontFamily: fonts.sansBold },
  quote: { fontSize: 16, lineHeight: 23, fontFamily: fonts.sans },
  meta: { fontSize: 13, lineHeight: 17, fontFamily: fonts.sans },
  mentionActions: { flexDirection: "row", flexWrap: "wrap", gap: 10, paddingLeft: 68 },
  events: { gap: 8, paddingHorizontal: 16, paddingBottom: 8 },
  event: { flexDirection: "row", gap: 12, paddingVertical: 12, paddingHorizontal: 14, borderRadius: radius.m, borderWidth: hairline },
  eventBar: { width: 4, borderRadius: 2 },
  eventTime: { width: 56, fontSize: 14, lineHeight: 20, fontFamily: fonts.monoSemibold, paddingTop: 1 },
  eventText: { flex: 1, minWidth: 0, gap: 3 },
  eventTitle: { fontSize: 16, lineHeight: 21, fontFamily: fonts.sansSemibold },
  ghost: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 40, paddingHorizontal: 8, borderRadius: radius.m, alignSelf: "flex-start" },
  fileRow: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 60, paddingVertical: 8, paddingHorizontal: 20 },
  fileName: { fontSize: 15, lineHeight: 20, fontFamily: fonts.sansSemibold },
  none: { paddingHorizontal: 20, paddingBottom: 8 },
});
