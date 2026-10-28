import type { ApiMessage } from "@ruchoir/client";
import { useNavigation } from "@react-navigation/native";
import { Image } from "expo-image";
import { MessageSquare, Pin } from "lucide-react-native";
import { memo, useState } from "react";
import { Alert, Keyboard, Pressable, StyleSheet, View } from "react-native";

import { authHeadersFor, useApi } from "../../api/useApi";
import { useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { listStamp, timeOf } from "../../logic/format";
import { thumbBox } from "../../logic/thumb";
import { useTabletLayout } from "../../layout/useWide";
import { hairline, radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { Avatar } from "../../ui/Avatar";
import { FileCard } from "../../ui/FileCard";
import { Flash } from "../../ui/Flash";
import { feel } from "../../ui/haptics";
import { Text } from "../../ui/Text";
import { EventCardView } from "./EventCardView";
import { LinkCard } from "./LinkCard";
import { ReactionPills } from "./ReactionPills";
import { RichText } from "./RichText";
import { SYSTEM_TEXT } from "./systemText";


type Props = {
  message: ApiMessage;
  /** Whether the author and time are drawn (false inside a run of one person's messages). */
  head: boolean;
  /** Whether the message names the reader, which tints its row. */
  mentionsMe: boolean;
  avatar?: string;
  mentionNames: string[];
  /** A message of mine still in the outbox: going out, or failed and waiting to be retried. */
  pending?: "sending" | "failed";
  onRetry?: () => void;
  onDiscard?: () => void;
  /** The reader, for the answer to an event they are invited to. */
  myUserId?: string;
  /** A long press: the message's sheet. */
  onLongPress?: () => void;
  /** A tap on a reaction pill, and on `+` beside them. */
  onReact?: (emoji: string) => void;
  onAddReaction?: () => void;
  /** A tap on the line under a message with replies: its thread. Absent inside the thread itself. */
  onOpenThread?: () => void;
  /** Faces for the people who replied, by name. */
  avatarOf?: (name: string) => string | undefined;
  /** The message someone was just taken to: it lights up a moment. */
  highlighted?: boolean;
};

/** One message of a conversation (mockup 13). */
export const MessageRow = memo(function MessageRow({
  message: m,
  head,
  mentionsMe,
  avatar,
  mentionNames,
  pending,
  onRetry,
  onDiscard,
  myUserId,
  onLongPress,
  onReact,
  onAddReaction,
  onOpenThread,
  avatarOf,
  highlighted,
}: Props) {
  const { t } = useTranslation();
  const { s } = useTheme();
  const tablet = useTabletLayout() !== null;
  const { locale, timeZone } = useLocale();
  const navigation = useNavigation();

  if (m.kind === "system") {
    const line = (
      <Text variant="small" tone="muted" style={styles.system}>
        {m.system ? t(SYSTEM_TEXT[m.system.event], { who: m.system.actor || t("message.someone"), detail: m.system.detail ?? "" }) : m.body}
      </Text>
    );
    // An event shared in the channel: the notice, then the card to open it and answer.
    if (m.eventCard && m.system?.event === "calendar_event_posted") {
      return (
        <View style={styles.systemCard}>
          {line}
          <EventCardView message={m} myUserId={myUserId} />
        </View>
      );
    }
    return line;
  }

  const images = m.images ?? (m.image ? [m.image] : []);
  const files = m.attachments ?? (m.attachment ? [m.attachment] : []);

  // A message that did not go: a tap sends it again, a long press offers to give up on it.
  const unsent =
    pending === "failed"
      ? {
          onPress: onRetry,
          onLongPress: () => {
            feel("menu");
            Alert.alert(t("compose.unsentTitle"), t("compose.unsentText"), [
              { text: t("common.retry"), onPress: onRetry },
              { text: t("compose.delete"), style: "destructive", onPress: onDiscard },
              { text: t("compose.cancel"), style: "cancel" },
            ]);
          },
        }
      : null;

  const actions = !pending && !m.deleted && onLongPress ? onLongPress : undefined;

  return (
    <Pressable
      disabled={!unsent && !actions}
      onPress={unsent?.onPress}
      onLongPress={
        unsent?.onLongPress ??
        (actions
          ? () => {
              feel("menu");
              // The keyboard goes down first: iOS hands the focus back to the composer as the sheet
              // closes, and the keyboard came back up by itself, over a composer left behind it.
              Keyboard.dismiss();
              actions();
            }
          : undefined)
      }
      delayLongPress={350}
      accessibilityHint={unsent ? t("compose.failed") : undefined}
      style={({ pressed }) => [
        styles.row,
        tablet && styles.rowTablet,
        mentionsMe && { backgroundColor: s.mention },
        !head && styles.continued,
        pending === "sending" && styles.sending,
        pressed && actions && { backgroundColor: s.pressed },
      ]}
    >
      {highlighted ? <Flash /> : null}
      <View style={[styles.gutter, tablet && styles.gutterTablet]}>{head ? <Avatar name={m.author} src={avatar} size={tablet ? 42 : 36} /> : null}</View>
      <View style={styles.main}>
        {m.parentId && m.alsoInChannel && m.threadRoot && onOpenThread ? (
          <ThreadLine root={m.threadRoot} onPress={onOpenThread} />
        ) : null}
        {head ? (
          <View style={styles.head}>
            <Text variant="bodyStrong" numberOfLines={1} style={styles.author}>
              {m.author}
            </Text>
            <Text variant="tiny" tone="muted">
              {timeOf(m.createdAt, locale, timeZone)}
            </Text>
            {m.pinned ? <PinnedTag /> : null}
          </View>
        ) : m.pinned ? (
          <PinnedTag />
        ) : null}
        {m.deleted ? (
          <Text tone="muted" style={styles.italic}>
            {t("message.deleted")}
          </Text>
        ) : m.body ? (
          <RichText body={m.body} mentionNames={mentionNames} />
        ) : null}
        {!m.deleted && m.link ? <LinkCard link={m.link} /> : null}
        {!m.deleted && images.length > 0 ? (
          <Pictures images={images} />
        ) : null}
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
        {!m.deleted && m.eventCard ? <EventCardView message={m} myUserId={myUserId} /> : null}
        {!m.deleted && m.reactions?.length && onReact && onAddReaction ? (
          <ReactionPills
            reactions={m.reactions}
            onToggle={onReact}
            onAdd={() => {
              Keyboard.dismiss();
              onAddReaction();
            }}
          />
        ) : null}
        {m.replies && onOpenThread ? <ReplyLine message={m} onPress={onOpenThread} avatarOf={avatarOf} /> : null}
        {m.edited && !m.deleted ? (
          <Text variant="tiny" tone="muted">
            {t("message.edited")}
          </Text>
        ) : null}
        {pending === "sending" ? (
          <Text variant="tiny" tone="muted">
            {t("compose.sending")}
          </Text>
        ) : pending === "failed" ? (
          <Text variant="tiny" tone="danger">
            {t("compose.failed")}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
});

/** Above a reply sent to the channel too: "replied to a thread", who started it and how, a way in. */
function ThreadLine({ root, onPress }: { root: NonNullable<ApiMessage["threadRoot"]>; onPress: () => void }) {
  const { t } = useTranslation();
  const { c } = useTheme();
  return (
    <Pressable accessibilityRole="button" onPress={onPress} hitSlop={6} style={({ pressed }) => [styles.threadLine, pressed && { opacity: 0.6 }]}>
      <MessageSquare size={13} color={c.muted} />
      <Text variant="tiny" tone="muted" numberOfLines={1} style={styles.threadText}>
        {t("thread.repliedToThread")}
        {root.excerpt ? (
          <>
            {" · "}
            {root.authorName ? <Text variant="tiny" style={{ color: c.ink }}>{root.authorName} </Text> : null}
            {root.excerpt}
          </>
        ) : (
          ` · ${t("message.deleted")}`
        )}
      </Text>
    </Pressable>
  );
}

/** "3 replies · last at 10:42", with up to three faces of those who answered, in the link colour. */
function ReplyLine({ message: m, onPress, avatarOf }: { message: ApiMessage; onPress: () => void; avatarOf?: (name: string) => string | undefined }) {
  const { t } = useTranslation();
  const { c } = useTheme();
  const { locale, timeZone } = useLocale();
  const stamp = m.lastReplyAt ? listStamp(m.lastReplyAt, new Date(), locale, timeZone) : null;
  const last = !stamp
    ? null
    : stamp.kind === "time"
      ? t("message.lastAt", { time: stamp.text })
      : stamp.kind === "yesterday"
        ? t("message.lastYesterday")
        : t("message.lastOn", { date: stamp.text });
  const faces = (m.replyAuthors ?? []).slice(0, 3);
  return (
    <Pressable accessibilityRole="button" onPress={onPress} hitSlop={6} style={({ pressed }) => [styles.replies, pressed && { opacity: 0.6 }]}>
      {faces.length > 0 ? (
        <View style={styles.faces}>
          {faces.map((name, i) => (
            <View key={name} style={[styles.face, { borderColor: c.surface }, i > 0 && styles.faceOverlap]}>
              <Avatar name={name} src={avatarOf?.(name)} size={20} />
            </View>
          ))}
        </View>
      ) : null}
      <Text variant="smallStrong" tone="link">
        {t("message.replies", { count: m.replies ?? 0 })}
      </Text>
      {last ? (
        <Text variant="tiny" tone="muted" numberOfLines={1} style={styles.shrink}>
          {last}
        </Text>
      ) : null}
    </Pressable>
  );
}

/**
 * A message's pictures, each whole in a box sized in points from the column's measured width
 * (`thumbBox`); a tap opens it full screen.
 */
function Pictures({ images }: { images: NonNullable<ApiMessage["images"]> }) {
  const api = useApi();
  const { absoluteUrl, fileDownloadUrl } = api;
  const { t } = useTranslation();
  const { c } = useTheme();
  const navigation = useNavigation();
  const [column, setColumn] = useState(0);
  return (
    <View style={styles.pictures} onLayout={(e) => setColumn(e.nativeEvent.layout.width)}>
      {column > 0
        ? images.map((img, i) => {
            if (!img.src) return null;
            const box = thumbBox(column, img.width, img.height);
            return (
              <Pressable
                key={img.fileId ?? i}
                onPress={() =>
                  img.fileId &&
                  navigation.navigate("fileViewer", {
                    file: { id: img.fileId, name: img.alt || t("message.image"), url: fileDownloadUrl(img.fileId), mime: "image/*" },
                  })
                }
                style={box}
              >
                <Image
                  source={{ uri: absoluteUrl(img.src), headers: authHeadersFor(api, absoluteUrl(img.src)) }}
                  accessibilityLabel={img.alt}
                  style={[styles.image, box, { borderColor: c.line }]}
                  contentFit="contain"
                />
              </Pressable>
            );
          })
        : null}
    </View>
  );
}

function PinnedTag() {
  const { t } = useTranslation();
  const { c } = useTheme();
  return (
    <View style={styles.pinned}>
      <Pin size={12} color={c.muted} />
      <Text variant="tiny" tone="muted">
        {t("message.pinnedTag")}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: 10, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 4 },
  continued: { paddingTop: 2 },
  sending: { opacity: 0.55 },
  gutter: { width: 36 },
  // The tablet mockups' message: a face of 42, 14 beside it, 12 around, rounded.
  rowTablet: { gap: 14, paddingHorizontal: 12, paddingTop: 12, paddingBottom: 6, borderRadius: radius.m },
  gutterTablet: { width: 42 },
  main: { flex: 1, minWidth: 0, gap: 6 },
  head: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  author: { flexShrink: 1 },
  italic: { fontStyle: "italic" },
  system: { textAlign: "center", paddingHorizontal: 24, paddingVertical: 8 },
  systemCard: { paddingHorizontal: 16, paddingBottom: 8, alignItems: "center" },
  pinned: { flexDirection: "row", alignItems: "center", gap: 3 },
  replies: { flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "flex-start", paddingVertical: 2 },
  threadLine: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "stretch", paddingBottom: 2 },
  threadText: { flexShrink: 1 },
  faces: { flexDirection: "row" },
  face: { borderWidth: 2, borderRadius: radius.s + 2 },
  faceOverlap: { marginLeft: -6 },
  shrink: { flexShrink: 1 },
  pictures: { alignSelf: "stretch", gap: 6 },
  image: { borderRadius: radius.m, borderWidth: hairline },
});
