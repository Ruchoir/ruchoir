import { fileDownloadUrl, search, type SearchMessage } from "@ruchoir/client";
import { useNavigation, type NavigationProp } from "@react-navigation/native";
import { SearchX } from "lucide-react-native";
import { useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import { useLoad } from "../../data/useLoad";
import { useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { listStamp } from "../../logic/format";
import type { RootParams } from "../../navigation/types";
import { useSpace } from "../../space/SpaceProvider";
import { useTheme } from "../../theme/useTheme";
import { ActionRow } from "../../ui/ActionRow";
import { Avatar } from "../../ui/Avatar";
import { FileIcon } from "../../ui/FileIcon";
import { FullScreen } from "../../ui/FullScreen";
import { SearchField } from "../../ui/SearchField";
import { SheetHeader } from "../../ui/SheetHeader";
import { EmptyState, LoadState } from "../../ui/States";
import { Text } from "../../ui/Text";
import { loadConversations } from "../discussions/DiscussionsScreen";

/**
 * "Search in Ruchoir" (Today on a tablet): the space's messages and file names at once. A message
 * opens its conversation at it (a reply, its thread at it), a file opens.
 */
export function SearchScreen() {
  const { t } = useTranslation();
  const { c } = useTheme();
  const { locale, timeZone } = useLocale();
  const navigation = useNavigation<NavigationProp<RootParams>>();
  const { current } = useSpace();
  const space = current?.id;
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);
  const hits = useLoad(space && debounced.length >= 2 ? `everywhere:${space}:${debounced}` : null, (signal) => search(space!, debounced, signal));
  // Where each message was said, by name.
  const conversations = useLoad(space ? `conversations:${space}` : null, (signal) => loadConversations(space!, signal));
  const byId = useMemo(() => new Map((conversations.data ?? []).map((item) => [item.id, item])), [conversations.data]);

  const open = (m: SearchMessage) => {
    const item = byId.get(m.conversationId);
    const title = item?.name ?? m.author;
    const channelId = item?.kind === "channel" ? m.conversationId : undefined;
    navigation.goBack();
    navigation.navigate("conversation", {
      conversationId: m.conversationId,
      title,
      channelId,
      kind: item?.kind,
      participants: item?.participants,
      focus: { id: m.parentId ?? m.id, replyId: m.parentId ? m.id : undefined },
    });
  };

  const data = hits.data;
  const empty = data && data.messages.length === 0 && data.files.length === 0;
  return (
    <FullScreen color={c.surface}>
      <SheetHeader title={t("search.everywhere")} onClose={() => navigation.goBack()} />
      <SearchField value={query} onChange={setQuery} placeholder={t("search.everywhere")} autoFocus />
      <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={styles.page}>
        {debounced.length < 2 ? null : !data ? (
          <LoadState error={hits.error} onRetry={hits.reload} />
        ) : empty ? (
          <EmptyState size="compact" icon={SearchX} title={t("search.nothing", { query: debounced })} text={t("search.tryAnother")} />
        ) : (
          <>
            {data.messages.length ? (
              <View style={styles.section}>
                <Text variant="label" tone="muted" style={styles.label}>
                  {t("conversation.messages")}
                </Text>
                {data.messages.map((m) => {
                  const where = byId.get(m.conversationId);
                  const stamp = listStamp(m.createdAt, new Date(), locale, timeZone);
                  const when = stamp.kind === "yesterday" ? t("files.yesterday") : stamp.text;
                  const place = where ? (where.kind === "channel" ? `#${where.name}` : where.name) : "";
                  return (
                    <ActionRow
                      key={m.id}
                      leading={<Avatar name={m.author} size={40} />}
                      title={m.body || t("discussions.files")}
                      subtitle={[m.author, place, when].filter(Boolean).join(" · ")}
                      onPress={() => open(m)}
                    />
                  );
                })}
              </View>
            ) : null}
            {data.files.length ? (
              <View style={styles.section}>
                <Text variant="label" tone="muted" style={styles.label}>
                  {t("tabs.files")}
                </Text>
                {data.files.map((f) => (
                  <ActionRow
                    key={f.id}
                    leading={<FileIcon name={f.name} folder={f.kind === "folder"} size={36} />}
                    title={f.name}
                    onPress={() => {
                      navigation.goBack();
                      if (f.kind === "folder") navigation.navigate("folder", { folderId: f.id, name: f.name });
                      else navigation.navigate("fileViewer", { file: { id: f.id, name: f.name, url: fileDownloadUrl(f.id) } });
                    }}
                  />
                ))}
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </FullScreen>
  );
}

const styles = StyleSheet.create({
  page: { paddingTop: 12, paddingBottom: 32, gap: 16 },
  section: { paddingHorizontal: 16, gap: 2 },
  label: { marginBottom: 4 },
});
