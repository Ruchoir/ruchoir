import { getFilesView, getFolder, searchFiles, type SpaceFile } from "@ruchoir/client";
import { useNavigation, type NavigationProp } from "@react-navigation/native";
import { Folder, FolderOpen, SearchX } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";

import { useLoad } from "../../data/useLoad";
import { useReloadOn } from "../../data/useReloadOn";
import { useTranslation } from "../../i18n";
import type { RootParams } from "../../navigation/types";
import { useSpace } from "../../space/SpaceProvider";
import { hairline, radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { SearchField } from "../../ui/SearchField";
import { EmptyState, LoadState } from "../../ui/States";
import { TabHeader } from "../../ui/TabHeader";
import { TabScreen } from "../../ui/TabScreen";
import { Text } from "../../ui/Text";
import { FileRow, openEntry } from "./FileRow";

/**
 * The space's files (mockup 20): a search, the folders at the root as tiles, the files at the root,
 * and what changed recently. Read-only in this step: no "Add a file".
 */
export function FilesScreen() {
  const { t } = useTranslation();
  const { current } = useSpace();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const space = current?.id;
  const root = useLoad(space ? `root:${space}` : null, (signal) => getFolder(space!, undefined, signal));
  const recent = useLoad(space ? `recent:${space}` : null, (signal) => getFilesView(space!, "recent", signal));
  const found = useLoad(space && debounced ? `search:${space}:${debounced}` : null, (signal) => searchFiles(space!, debounced, signal));
  useReloadOn((e) => e.type === "files" && e.spaceId === space, () => {
    root.reload();
    recent.reload();
  });

  const folders = root.data?.entries.filter((f) => f.kind === "folder") ?? [];
  const files = root.data?.entries.filter((f) => f.kind !== "folder") ?? [];

  return (
    <TabScreen>
      <ScrollView
        contentContainerStyle={styles.page}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={false}
            onRefresh={() => {
              root.reload();
              recent.reload();
            }}
          />
        }
      >
        <TabHeader title={t("tabs.files")} />
        <SearchField value={query} onChange={setQuery} placeholder={t("files.search")} />
        {debounced ? (
          found.data ? (
            found.data.length ? (
              found.data.map((entry) => <FileRow key={entry.file.id} file={entry.file} line={entry.path.map((p) => p.name).join(" / ") || undefined} />)
            ) : (
              <EmptyState icon={SearchX} title={t("files.noMatch")} />
            )
          ) : (
            <LoadState error={found.error} onRetry={found.reload} />
          )
        ) : !root.data ? (
          <LoadState error={root.error} onRetry={root.reload} />
        ) : (
          <>
            {folders.length ? <FolderTiles folders={folders} /> : null}
            {files.length ? <Section title={t("files.atRoot")} files={files} /> : null}
            {recent.data?.length ? <Section title={t("files.recent")} files={recent.data.slice(0, 20).map((e) => e.file)} /> : null}
            {!folders.length && !files.length ? <EmptyState icon={FolderOpen} title={t("files.empty")} /> : null}
          </>
        )}
      </ScrollView>
    </TabScreen>
  );
}

function FolderTiles({ folders }: { folders: SpaceFile[] }) {
  const { c } = useTheme();
  const navigation = useNavigation<NavigationProp<RootParams>>();
  return (
    <View style={styles.grid}>
      {folders.map((folder) => (
        <Pressable
          key={folder.id}
          accessibilityRole="button"
          onPress={() => openEntry(navigation, folder)}
          style={({ pressed }) => [styles.tile, { borderColor: c.lineStrong, backgroundColor: c.surface }, pressed && { opacity: 0.6 }]}
        >
          <Folder size={20} color={c.ink} />
          <Text variant="smallStrong" numberOfLines={1} style={styles.tileName}>
            {folder.name}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function Section({ title, files }: { title: string; files: SpaceFile[] }) {
  return (
    <View>
      <Text variant="small" tone="muted" style={styles.section}>
        {title}
      </Text>
      {files.map((f, i) => (
        <FileRow key={f.id ?? i} file={f} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { paddingBottom: 24, gap: 12, flexGrow: 1 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10, paddingHorizontal: 16 },
  tile: {
    flexBasis: "47%",
    flexGrow: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    height: 52,
    paddingHorizontal: 14,
    borderRadius: radius.m,
    borderWidth: hairline,
  },
  tileName: { flexShrink: 1 },
  section: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 2 },
});
