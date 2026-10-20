import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import { Hash, Lock, MessageSquareOff } from "lucide-react-native";
import { Fragment, useState } from "react";
import { StyleSheet, View } from "react-native";

import { useApi } from "../../api/useApi";
import { useLoad } from "../../data/useLoad";
import { useTranslation } from "../../i18n";
import { buildConversations, listConversations, type ConversationItem } from "../../logic/conversations";
import type { RootParams } from "../../navigation/types";
import { hairline } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { ActionRow } from "../../ui/ActionRow";
import { Avatar } from "../../ui/Avatar";
import { Button } from "../../ui/Button";
import { KeyboardForm } from "../../ui/KeyboardForm";
import { SearchField } from "../../ui/SearchField";
import { SheetHeader } from "../../ui/SheetHeader";
import { EmptyState, LoadState } from "../../ui/States";
import { Text } from "../../ui/Text";
import { TextField } from "../../ui/TextField";
import { useToast } from "../../ui/Toast";

/**
 * Where to send a file (the web's share dialog): the person's favourite channels, then their direct
 * messages, then the other channels they are in; a search; an optional word; the file goes as an
 * attachment of a message there.
 */
export function ConversationPicker() {
  const { getChannels, getDirectMessages, sendMessage } = useApi();
  const { params } = useRoute<RouteProp<RootParams, "fileSendTo">>();
  const navigation = useNavigation();
  const { t } = useTranslation();
  const { c } = useTheme();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<ConversationItem | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const data = useLoad(`sendTo:${params.spaceId}`, async (signal) => {
    const [channels, dms] = await Promise.all([getChannels(params.spaceId, signal), getDirectMessages(params.spaceId, signal)]);
    const mine = channels.filter((ch) => ch.member !== false);
    return { items: buildConversations(mine, dms), favourites: new Set(mine.filter((ch) => ch.fav).map((ch) => ch.id)) };
  });
  const items = data.data ? listConversations(data.data.items, "all", query) : [];
  const fav = data.data?.favourites ?? new Set<string>();
  const byName = (a: ConversationItem, b: ConversationItem) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  const sections = [
    { key: "fav", title: t("sidebar.favourites"), rows: items.filter((i) => i.kind === "channel" && fav.has(i.id)).sort(byName) },
    { key: "dms", title: t("sidebar.directMessages"), rows: items.filter((i) => i.kind !== "channel") },
    { key: "channels", title: t("discussions.filterGroups"), rows: items.filter((i) => i.kind === "channel" && !fav.has(i.id)).sort(byName) },
  ].filter((s) => s.rows.length > 0);
  const label = (i: ConversationItem) => (i.kind === "channel" ? `#${i.name}` : i.name);

  const send = async () => {
    if (!chosen) return;
    setBusy(true);
    try {
      await sendMessage(chosen.id, note.trim(), { attachments: [params.file.id!] });
      navigation.goBack();
      toast(t("files.sentTo", { name: label(chosen) }));
    } catch {
      setBusy(false);
      toast(t("files.sendFailed"), "failure");
    }
  };

  return (
    <View style={[styles.fill, { backgroundColor: c.surface }]}>
      <SheetHeader title={t("files.sendToConversation")} onClose={() => navigation.goBack()} />
      <KeyboardForm
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.form}
        footer={
          <View style={[styles.foot, { borderTopColor: c.line, backgroundColor: c.surface }]}>
            {chosen ? (
              <TextField label={t("files.shareNote")} placeholder={t("files.shareNotePlaceholder")} value={note} onChangeText={setNote} multiline />
            ) : null}
            <Button label={chosen ? `${t("compose.send")} · ${label(chosen)}` : t("compose.send")} disabled={!chosen} busy={busy} onPress={() => void send()} />
          </View>
        }
      >
        <SearchField value={query} onChange={setQuery} placeholder={t("files.findConversation")} />
        {!data.data ? <LoadState error={data.error} onRetry={data.reload} /> : null}
        {data.data && items.length === 0 ? <EmptyState size="compact" icon={MessageSquareOff} title={t("files.noConversation")} /> : null}
        {sections.map((section) => (
          <Fragment key={section.key}>
            <Text variant="smallStrong" tone="muted" style={styles.section}>
              {section.title}
            </Text>
            <View style={styles.gutter}>
              {section.rows.map((i) => (
                <ActionRow
                  key={i.id}
                  icon={i.kind === "channel" ? (i.private ? Lock : Hash) : undefined}
                  tint={i.kind === "channel" ? c.pink : undefined}
                  leading={i.kind === "channel" ? undefined : <Avatar name={i.name} size={40} />}
                  title={label(i)}
                  selected={chosen?.id === i.id}
                  trailing={chosen?.id === i.id ? <View style={[styles.dot, { backgroundColor: c.ink }]} /> : undefined}
                  onPress={() => setChosen(i)}
                />
              ))}
            </View>
          </Fragment>
        ))}
      </KeyboardForm>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  form: { gap: 6, paddingTop: 4, paddingBottom: 16 },
  gutter: { paddingHorizontal: 16 },
  section: { paddingHorizontal: 16, marginTop: 10 },
  dot: { width: 12, height: 12, borderRadius: 6 },
  foot: { gap: 10, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, borderTopWidth: hairline },
});
