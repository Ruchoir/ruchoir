import { absoluteUrl, fileDownloadUrl, type ApiMessage, type SystemEvent } from "@ruchoir/client";
import { useNavigation } from "@react-navigation/native";
import { Image } from "expo-image";
import { CalendarDays } from "lucide-react-native";
import { memo } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { authHeaders } from "../../api/instance";
import { key, useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { timeOf } from "../../logic/format";
import { hairline, radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { Avatar } from "../../ui/Avatar";
import { FileCard } from "../../ui/FileCard";
import { Text } from "../../ui/Text";
import { RichText } from "./RichText";

const EVENT_TEXT: Record<SystemEvent, ReturnType<typeof key>> = {
  member_joined: key("system.memberJoined"),
  member_left: key("system.memberLeft"),
  member_removed: key("system.memberRemoved"),
  channel_joined: key("system.channelJoined"),
  channel_left: key("system.channelLeft"),
  channel_removed: key("system.channelRemoved"),
  channel_created: key("system.channelCreated"),
  channel_renamed: key("system.channelRenamed"),
  channel_topic_changed: key("system.channelTopicChanged"),
  channel_topic_cleared: key("system.channelTopicCleared"),
  channel_made_private: key("system.channelMadePrivate"),
  channel_made_public: key("system.channelMadePublic"),
  channel_archived: key("system.channelArchived"),
  channel_unarchived: key("system.channelUnarchived"),
  channel_access_changed: key("system.channelAccessChanged"),
  calendar_event_posted: key("system.calendarEventPosted"),
  calendar_event_changed: key("system.calendarEventChanged"),
  calendar_event_cancelled: key("system.calendarEventCancelled"),
};

type Props = {
  message: ApiMessage;
  /** Whether the author and time are drawn (false inside a run of one person's messages). */
  head: boolean;
  /** Whether the message names the reader, which tints its row. */
  mentionsMe: boolean;
  avatar?: string;
  mentionNames: string[];
};

/** One message of a conversation (mockup 13), read-only. */
export const MessageRow = memo(function MessageRow({ message: m, head, mentionsMe, avatar, mentionNames }: Props) {
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const { locale, timeZone } = useLocale();
  const navigation = useNavigation();

  if (m.kind === "system") {
    return (
      <Text variant="small" tone="muted" style={styles.system}>
        {m.system ? t(EVENT_TEXT[m.system.event], { who: m.system.actor || t("message.someone"), detail: m.system.detail ?? "" }) : m.body}
      </Text>
    );
  }

  const images = m.images ?? (m.image ? [m.image] : []);
  const files = m.attachments ?? (m.attachment ? [m.attachment] : []);

  return (
    <View style={[styles.row, mentionsMe && { backgroundColor: s.mention }, !head && styles.continued]}>
      <View style={styles.gutter}>{head ? <Avatar name={m.author} src={avatar} size={36} /> : null}</View>
      <View style={styles.main}>
        {head ? (
          <View style={styles.head}>
            <Text variant="bodyStrong" numberOfLines={1} style={styles.author}>
              {m.author}
            </Text>
            <Text variant="tiny" tone="muted">
              {timeOf(m.createdAt, locale, timeZone)}
            </Text>
          </View>
        ) : null}
        {m.deleted ? (
          <Text tone="muted" style={styles.italic}>
            {t("message.deleted")}
          </Text>
        ) : m.body ? (
          <RichText body={m.body} mentionNames={mentionNames} />
        ) : null}
        {!m.deleted &&
          images.map((img, i) =>
            img.src ? (
              <Pressable
                key={img.fileId ?? i}
                onPress={() =>
                  img.fileId &&
                  navigation.navigate("fileViewer", {
                    file: { id: img.fileId, name: img.alt || t("message.image"), url: fileDownloadUrl(img.fileId), mime: "image/*" },
                  })
                }
              >
                <Image
                  source={{ uri: absoluteUrl(img.src), headers: authHeaders() }}
                  accessibilityLabel={img.alt}
                  style={[styles.image, { aspectRatio: img.width && img.height ? img.width / img.height : 4 / 3, borderColor: c.line }]}
                  contentFit="cover"
                />
              </Pressable>
            ) : null,
          )}
        {!m.deleted &&
          files.map((f, i) => (
            <FileCard
              key={f.fileId ?? i}
              name={f.name}
              sizeBytes={f.sizeBytes}
              onPress={
                f.url && !f.deleted
                  ? () => navigation.navigate("fileViewer", { file: { id: f.fileId ?? f.name, name: f.name, url: f.url!, sizeBytes: f.sizeBytes } })
                  : undefined
              }
            />
          ))}
        {!m.deleted && m.eventCard ? (
          <Pressable
            onPress={() => navigation.navigate("eventSummary", { eventId: m.eventCard!.eventId, recurrenceId: m.eventCard!.recurrenceId })}
            style={({ pressed }) => [styles.event, { borderColor: c.ink, backgroundColor: c.surface }, pressed && { opacity: 0.7 }]}
          >
            <View style={[styles.eventIcon, { backgroundColor: c.sky }]}>
              <CalendarDays size={18} color={c.onPastel} />
            </View>
            <View style={styles.main}>
              <Text variant="smallStrong" numberOfLines={1}>
                {m.eventCard.title}
              </Text>
              <Text variant="tiny" tone="muted">
                {new Intl.DateTimeFormat(locale, {
                  timeZone,
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                  ...(m.eventCard.allDay ? {} : { hour: "2-digit", minute: "2-digit" }),
                }).format(new Date(m.eventCard.start))}
              </Text>
            </View>
          </Pressable>
        ) : null}
        {m.edited && !m.deleted ? (
          <Text variant="tiny" tone="muted">
            {t("message.edited")}
          </Text>
        ) : null}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: 10, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 4 },
  continued: { paddingTop: 2 },
  gutter: { width: 36 },
  main: { flex: 1, minWidth: 0, gap: 6 },
  head: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  author: { flexShrink: 1 },
  italic: { fontStyle: "italic" },
  system: { textAlign: "center", paddingHorizontal: 24, paddingVertical: 8 },
  image: { width: "100%", maxWidth: 300, borderRadius: radius.m, borderWidth: hairline },
  event: { flexDirection: "row", alignItems: "center", gap: 10, padding: 10, borderRadius: radius.m, borderWidth: 2, maxWidth: 320 },
  eventIcon: { width: 36, height: 36, borderRadius: radius.s, alignItems: "center", justifyContent: "center" },
});
