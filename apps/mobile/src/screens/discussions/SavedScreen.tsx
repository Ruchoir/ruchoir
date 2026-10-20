/**
 * "Saved messages", from my account: every message I bookmarked, in every space, newest first, as
 * the web's saved view. A tap takes me to the message in its conversation (moving to its space when
 * it is another one); the bookmark is taken off from the message's own menu, or here with a long press.
 */
import { getSavedMessages, setMessageSaved, type SavedMessage } from "@ruchoir/client";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Bookmark } from "lucide-react-native";
import { Alert, FlatList, Pressable, StyleSheet, View } from "react-native";

import { useSpaceMembers } from "../../data/members";
import { useLoad } from "../../data/useLoad";
import { useNow } from "../../data/useNow";
import { useReloadOn } from "../../data/useReloadOn";
import { useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { listStamp } from "../../logic/format";
import { plainExcerpt } from "../../logic/inline";
import type { RootParams } from "../../navigation/types";
import { useSpace } from "../../space/SpaceProvider";
import { useTheme } from "../../theme/useTheme";
import { Avatar } from "../../ui/Avatar";
import { feel } from "../../ui/haptics";
import { SheetHeader } from "../../ui/SheetHeader";
import { EmptyState, LoadState } from "../../ui/States";
import { Text } from "../../ui/Text";
import { useToast } from "../../ui/Toast";

export function SavedScreen() {
  const { t } = useTranslation();
  const { c } = useTheme();
  const { locale, timeZone } = useLocale();
  const now = useNow();
  const toast = useToast();
  const { current, select } = useSpace();
  const people = useSpaceMembers(current?.id);
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const saved = useLoad("saved", (signal) => getSavedMessages(signal));
  // A bookmark set or taken off from a message's menu, here or in a conversation.
  useReloadOn((e) => e.type === "patched", saved.reload, 300);

  const open = (row: SavedMessage) => {
    const m = row.message;
    if (row.spaceId !== current?.id) select(row.spaceId);
    navigation.goBack();
    navigation.navigate("conversation", {
      conversationId: row.conversationId,
      title: row.channelName ?? m.author,
      channelId: row.channelName ? row.conversationId : undefined,
      kind: row.channelName ? "channel" : undefined,
      focus: { id: m.parentId ?? m.id, replyId: m.parentId ? m.id : undefined },
    });
  };

  const unsave = (row: SavedMessage) => {
    feel("menu");
    Alert.alert(t("saved.removeTitle"), undefined, [
      { text: t("compose.cancel"), style: "cancel" },
      {
        text: t("message.unsave"),
        style: "destructive",
        onPress: () =>
          setMessageSaved(row.message.id, false).then(saved.reload, () => toast(t("message.actionFailed"), "failure")),
      },
    ]);
  };

  return (
    <View style={[styles.fill, { backgroundColor: c.surface }]}>
      <SheetHeader title={t("saved.title")} onClose={() => navigation.goBack()} />
      {!saved.data ? (
        <LoadState error={saved.error} onRetry={saved.reload} />
      ) : saved.data.length === 0 ? (
        <EmptyState size="hero" icon={Bookmark} title={t("saved.empty")} text={t("saved.emptyText")} />
      ) : (
        <FlatList
          data={saved.data}
          keyExtractor={(row) => row.message.id}
          contentContainerStyle={styles.list}
          ItemSeparatorComponent={() => <View style={[styles.rule, { backgroundColor: c.line }]} />}
          renderItem={({ item: row }) => {
            const m = row.message;
            const stamp = listStamp(m.createdAt, new Date(now), locale, timeZone);
            const where = row.channelName ? `#${row.channelName}` : t("saved.direct");
            return (
              <Pressable
                accessibilityRole="button"
                onPress={() => open(row)}
                onLongPress={() => unsave(row)}
                style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
              >
                <Avatar name={m.author} src={people.avatarOf(m.author)} size={36} />
                <View style={styles.body}>
                  <View style={styles.line}>
                    <Text variant="bodyStrong" numberOfLines={1} style={styles.shrink}>
                      {m.author}
                    </Text>
                    {stamp ? (
                      <Text variant="tiny" tone="muted">
                        {stamp.kind === "yesterday" ? t("time.yesterday") : stamp.text}
                      </Text>
                    ) : null}
                  </View>
                  <Text variant="tiny" tone="muted" numberOfLines={1}>
                    {`${where} · ${row.spaceName}`}
                  </Text>
                  <Text variant="small" tone="body" numberOfLines={3}>
                    {plainExcerpt(m.body) || t("tabs.files")}
                  </Text>
                </View>
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  list: { paddingBottom: 32 },
  row: { flexDirection: "row", gap: 12, paddingHorizontal: 16, paddingVertical: 10 },
  body: { flex: 1, minWidth: 0, gap: 2 },
  line: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  shrink: { flexShrink: 1 },
  rule: { height: 1, marginLeft: 64 },
});
