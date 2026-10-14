/**
 * What can be done with a message, on a long press (the web's phone sheet): react at once or from
 * the whole picker, copy its text, edit or delete my own, pin it for a space's admins.
 *
 * Only what leads somewhere is offered: no row for something this person cannot do.
 */
import { QUICK_REACTIONS } from "@ruchoir/client/emoji";
import { deleteMessage, setMessagePinned } from "@ruchoir/client";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as Clipboard from "expo-clipboard";
import { Copy, MessageSquareReply, PenLine, Pin, PinOff, SmilePlus, Trash2 } from "lucide-react-native";
import { Alert, Pressable, StyleSheet, View } from "react-native";

import { requestEdit } from "../../compose/requests";
import { useReact } from "../../compose/useReact";
import { useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import type { RootParams } from "../../navigation/types";
import { useRealtimeActions } from "../../realtime/RealtimeProvider";
import { useSession } from "../../session/SessionProvider";
import { useSpace } from "../../space/SpaceProvider";
import { hairline, radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { ActionRow } from "../../ui/ActionRow";
import { Sheet } from "../../ui/Sheet";
import { Text } from "../../ui/Text";
import { useToast } from "../../ui/Toast";

export function MessageActionSheet() {
  const { params } = useRoute<RouteProp<RootParams, "messageActions">>();
  const { message: m, conversationId, channelId, draftKey, inThread, fromList } = params;
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const { locale, timeZone } = useLocale();
  const { state } = useSession();
  const { current } = useSpace();
  const { emit } = useRealtimeActions();
  const react = useReact();
  const toast = useToast();

  const own = state.kind === "signedIn" && m.authorId === state.user.id;
  const canPin = !!channelId && (current?.role === "owner" || current?.role === "admin");
  const close = () => navigation.goBack();
  const sentAt = new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(m.createdAt));

  const copy = () => {
    close();
    void Clipboard.setStringAsync(m.body).then(() => toast(t("message.copied")));
  };

  const edit = () => {
    close();
    requestEdit({ draftKey, id: m.id, body: m.body });
  };

  const togglePin = () => {
    close();
    const pinned = !m.pinned;
    emit({ type: "patched", conversationId, message: { ...m, pinned: pinned || undefined } });
    setMessagePinned(channelId!, m.id, pinned).then(
      () => toast(pinned ? t("message.pinnedDone") : t("message.unpinnedDone")),
      () => {
        emit({ type: "patched", conversationId, message: m });
        toast(t("message.actionFailed"));
      },
    );
  };

  const remove = () =>
    Alert.alert(t("message.deleteTitle"), t("message.deleteText"), [
      { text: t("compose.cancel"), style: "cancel" },
      {
        text: t("compose.delete"),
        style: "destructive",
        onPress: () => {
          close();
          emit({ type: "patched", conversationId, message: { ...m, deleted: true } });
          deleteMessage(m.id).catch(() => {
            emit({ type: "patched", conversationId, message: m });
            toast(t("message.deleteFailed"));
          });
        },
      },
    ]);

  return (
    <Sheet>
      <Text variant="label" tone="muted">
        {t("message.sentAt", { at: sentAt })}
      </Text>
      <View style={styles.quick}>
        {QUICK_REACTIONS.map((emoji) => {
          const mine = !!m.reactions?.find((r) => r.emoji === emoji)?.mine;
          return (
            <Pressable
              key={emoji}
              accessibilityRole="button"
              accessibilityLabel={t("message.reactWith", { emoji })}
              accessibilityState={{ selected: mine }}
              onPress={() => {
                react(conversationId, m, emoji);
                close();
              }}
              style={({ pressed }) => [
                styles.emoji,
                { backgroundColor: mine ? s.selected : s.sunken, borderColor: mine ? c.ink : "transparent" },
                pressed && { opacity: 0.6 },
              ]}
            >
              <Text style={styles.glyph}>{emoji}</Text>
            </Pressable>
          );
        })}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("message.moreReactions")}
          onPress={() => navigation.replace("emojiPicker", { conversationId, message: m })}
          style={({ pressed }) => [styles.emoji, { backgroundColor: s.sunken, borderColor: "transparent" }, pressed && { opacity: 0.6 }]}
        >
          <SmilePlus size={22} color={c.ink} />
        </Pressable>
      </View>
      {!inThread && !m.parentId ? (
        <ActionRow
          icon={MessageSquareReply}
          tint={c.mint}
          title={t("message.replyInThread")}
          onPress={() => {
            close();
            navigation.navigate("thread", { conversationId, channelId, rootId: m.id, title: params.title, root: m });
          }}
        />
      ) : null}
      {m.body ? <ActionRow icon={Copy} tint={c.sky} title={t("message.copy")} onPress={copy} /> : null}
      {own && !fromList ? <ActionRow icon={PenLine} tint={c.violet} title={t("message.edit")} onPress={edit} /> : null}
      {canPin ? (
        <ActionRow icon={m.pinned ? PinOff : Pin} tint={c.sun} title={m.pinned ? t("message.unpin") : t("message.pin")} onPress={togglePin} />
      ) : null}
      {own ? (
        <>
          <View style={[styles.rule, { backgroundColor: c.line }]} />
          <ActionRow icon={Trash2} danger title={t("message.delete")} onPress={remove} />
        </>
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  quick: { flexDirection: "row", justifyContent: "space-between", gap: 6, marginTop: 10, marginBottom: 8 },
  emoji: { flex: 1, maxWidth: 52, aspectRatio: 1, borderRadius: radius.m, borderWidth: hairline, alignItems: "center", justifyContent: "center" },
  glyph: { fontSize: 24, lineHeight: 30 },
  rule: { height: hairline, marginVertical: 6 },
});
