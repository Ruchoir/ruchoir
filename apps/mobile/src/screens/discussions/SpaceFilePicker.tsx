/**
 * A file of the space to attach (mockup 14's "From the space's files"): a search over the whole
 * space, the recent files, and the folders to walk through. The file is attached as itself, nothing
 * is uploaded again.
 */
import { getFilesView, getFolder, searchFiles, type SpaceFile } from "@ruchoir/client";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import { ChevronLeft, FolderOpen, SearchX } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { requestAttach } from "../../compose/requests";
import { useLoad } from "../../data/useLoad";
import { useTranslation } from "../../i18n";
import type { RootParams } from "../../navigation/types";
import { useSpace } from "../../space/SpaceProvider";
import { useTheme } from "../../theme/useTheme";
import { SearchField } from "../../ui/SearchField";
import { EmptyState, LoadState } from "../../ui/States";
import { Text } from "../../ui/Text";
import { FileRow } from "../files/FileRow";

const RECENT = 5;

export function SpaceFilePicker() {
  const { params } = useRoute<RouteProp<RootParams, "spaceFilePicker">>();
  const navigation = useNavigation();
  const { t } = useTranslation();
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const { current } = useSpace();
  const space = params.spaceId ?? current?.id;
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [path, setPath] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const folderId = path[path.length - 1]?.id;
  const folder = useLoad(space ? `pick:${space}:${folderId ?? "root"}` : null, (signal) => getFolder(space!, folderId, signal));
  const recent = useLoad(space && !folderId ? `recent:${space}` : null, (signal) => getFilesView(space!, "recent", signal));
  const found = useLoad(space && debounced ? `search:${space}:${debounced}` : null, (signal) => searchFiles(space!, debounced, signal));

  const pick = (file: SpaceFile) => {
    requestAttach({ draftKey: params.draftKey, kind: "space", file });
    navigation.goBack();
  };
  const open = (file: SpaceFile) => {
    if (!file.id) return;
    if (file.kind === "folder") {
      setQuery("");
      setPath((prev) => [...prev, { id: file.id!, name: file.name }]);
    } else pick(file);
  };

  const entries = folder.data?.entries ?? [];
  const folders = entries.filter((f) => f.kind === "folder");
  const files = entries.filter((f) => f.kind !== "folder");

  // One scroll view as the sheet's root, its head pinned: on iOS a sheet's content has no set height,
  // so a fixed head beside a list that fills the rest leaves the list drawn under the head.
  return (
    <ScrollView
      style={{ backgroundColor: c.surface }}
      stickyHeaderIndices={[0]}
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
    >
      <View style={[styles.head, { backgroundColor: c.surface }]}>
        <Text variant="heading" style={styles.title}>
          {t("attach.space")}
        </Text>
        <SearchField value={query} onChange={setQuery} placeholder={t("files.search")} />
      </View>
      <View>
        {debounced ? (
          found.data ? (
            found.data.length ? (
              found.data.map((entry) => (
                <FileRow
                  key={entry.file.id}
                  file={entry.file}
                  line={entry.path.map((p) => p.name).join(" / ") || undefined}
                  onPress={() => (entry.file.kind === "folder" ? setPath([...entry.path, { id: entry.file.id!, name: entry.file.name }]) : pick(entry.file))}
                />
              ))
            ) : (
              <EmptyState size="compact" icon={SearchX} title={t("files.noMatch")} text={t("search.tryAnother")} />
            )
          ) : (
            <LoadState error={found.error} onRetry={found.reload} />
          )
        ) : (
          <>
            {path.length > 0 ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => setPath((prev) => prev.slice(0, -1))}
                style={({ pressed }) => [styles.back, pressed && { opacity: 0.6 }]}
              >
                <ChevronLeft size={20} color={c.ink} />
                <Text variant="bodyStrong" numberOfLines={1} style={styles.grow}>
                  {path[path.length - 1].name}
                </Text>
              </Pressable>
            ) : null}
            {!folderId && recent.data?.length ? (
              <>
                <Text variant="label" tone="muted" style={styles.section}>
                  {t("files.recent")}
                </Text>
                {recent.data
                  .filter((e) => e.file.kind !== "folder")
                  .slice(0, RECENT)
                  .map((entry) => (
                    <FileRow key={`r:${entry.file.id}`} file={entry.file} onPress={() => pick(entry.file)} />
                  ))}
                <Text variant="label" tone="muted" style={styles.section}>
                  {t("attach.allFiles")}
                </Text>
              </>
            ) : null}
            {!folder.data ? (
              <LoadState error={folder.error} onRetry={folder.reload} />
            ) : entries.length === 0 ? (
              <EmptyState size="compact" icon={FolderOpen} title={t("files.folderEmpty")} />
            ) : (
              [...folders, ...files].map((file) => <FileRow key={file.id} file={file} onPress={() => open(file)} />)
            )}
          </>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  head: { paddingTop: 24, paddingBottom: 8, gap: 12 },
  // A little air between the sheet's title and its search field.
  title: { paddingHorizontal: 16, marginBottom: 6 },
  back: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 10 },
  grow: { flex: 1 },
  section: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 },
});
