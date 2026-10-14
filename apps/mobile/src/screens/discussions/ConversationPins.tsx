import { getPinnedMessages } from "@ruchoir/client";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Pin } from "lucide-react-native";
import { FlatList, Pressable, StyleSheet, View } from "react-native";

import { useSpaceMembers } from "../../data/members";
import { useLoad } from "../../data/useLoad";
import { useNow } from "../../data/useNow";
import { useReloadOn } from "../../data/useReloadOn";
import { useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { listStamp } from "../../logic/format";
import { plainExcerpt } from "../../logic/inline";
import type { RootParams } from "../../navigation/types";
import { affects } from "../../realtime/events";
import { useSpace } from "../../space/SpaceProvider";
import { useTheme } from "../../theme/useTheme";
import { Avatar } from "../../ui/Avatar";
import { EmptyState, LoadState } from "../../ui/States";
import { Text } from "../../ui/Text";

/**
 * A channel's pinned messages, a tab of the conversation as its files are. Followed live (pinned,
 * unpinned, edited, deleted); a tap opens the message's own menu, to unpin it, copy it or answer it
 * in its thread.
 */
export function ConversationPins({ channelId, title }: { channelId: string; title: string }) {
  const { t } = useTranslation();
  const { c } = useTheme();
  const { locale, timeZone } = useLocale();
  const now = useNow();
  const { current } = useSpace();
  const people = useSpaceMembers(current?.id);
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const pins = useLoad(`pins:${channelId}`, (signal) => getPinnedMessages(channelId, signal));
  useReloadOn((e) => affects.pins(e, channelId), pins.reload, 300);
  if (!pins.data) return <LoadState error={pins.error} onRetry={pins.reload} />;
  return (
    <FlatList
      data={pins.data}
      keyExtractor={(m) => m.id}
      contentContainerStyle={styles.list}
      ItemSeparatorComponent={() => <View style={[styles.rule, { backgroundColor: c.line }]} />}
      renderItem={({ item: m }) => {
        const stamp = listStamp(m.createdAt, new Date(now), locale, timeZone);
        return (
          <Pressable
            accessibilityRole="button"
            onPress={() =>
              navigation.navigate("messageActions", {
                conversationId: channelId,
                channelId,
                title,
                draftKey: channelId,
                fromList: true,
                message: m,
              })
            }
            style={({ pressed }) => [styles.pin, pressed && { backgroundColor: c.line }]}
          >
            <Avatar name={m.author} src={people.avatarOf(m.author)} size={36} />
            <View style={styles.text}>
              <View style={styles.head}>
                <Text variant="smallStrong" numberOfLines={1} style={styles.shrink}>
                  {m.author}
                </Text>
                <Text variant="tiny" tone="muted">
                  {stamp.kind === "yesterday" ? t("time.yesterday") : stamp.text}
                </Text>
              </View>
              <Text variant="small" tone="body" numberOfLines={4}>
                {m.deleted ? t("message.deleted") : plainExcerpt(m.body)}
              </Text>
            </View>
          </Pressable>
        );
      }}
      ListEmptyComponent={<EmptyState icon={Pin} title={t("details.noPinned")} text={t("conversation.noPinnedHint")} />}
    />
  );
}

const styles = StyleSheet.create({
  list: { flexGrow: 1, paddingVertical: 4 },
  pin: { flexDirection: "row", gap: 12, paddingHorizontal: 16, paddingVertical: 10 },
  text: { flex: 1, minWidth: 0, gap: 2 },
  head: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  shrink: { flexShrink: 1 },
  rule: { height: 1, marginLeft: 64 },
});
