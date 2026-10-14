import { getFilesView, getFolder, searchFiles, type SpaceFile } from "@ruchoir/client";
import { useNavigation, type NavigationProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Folder, FolderOpen, SearchX, Upload } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";

import { useLoad } from "../../data/useLoad";
import { useReloadOn } from "../../data/useReloadOn";
import { useTranslation } from "../../i18n";
import type { RootParams } from "../../navigation/types";
import { useSpace } from "../../space/SpaceProvider";
import { hairline, radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { FloatingButton } from "../../ui/FloatingButton";
import { SearchField } from "../../ui/SearchField";
import { EmptyState, LoadState } from "../../ui/States";
import { NoSpace } from "../../ui/NoSpace";
import { TabHeader } from "../../ui/TabHeader";
import { TabScreen } from "../../ui/TabScreen";
import { Text } from "../../ui/Text";
import { FileRow, openEntry } from "./FileRow";
import { UploadStrip } from "./UploadStrip";

/**
 * The space's files (mockup 20): a search, the folders at the root as tiles, the files at the root,
 * and what changed recently. "Add a file" puts files at the space's root.
 */
export function FilesScreen() {
  const { t } = useTranslation();
  const { current, status } = useSpace();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
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

  if (status === "none") return <NoSpace title={t("tabs.files")} />;

  return (
    <TabScreen>
      <ScrollView
        contentContainerStyle={styles.page}
        automaticallyAdjustKeyboardInsets
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
        {space ? <UploadStrip spaceId={space} /> : null}
        {debounced ? (
          found.data ? (
            found.data.length ? (
              found.data.map((entry) => {
                const path = entry.path.map((p) => p.name).join(" / ") || undefined;
                return <FileRow key={entry.file.id} file={entry.file} line={path} path={path} />;
              })
            ) : (
              <EmptyState size="compact" icon={SearchX} title={t("files.noMatch")} text={t("search.tryAnother")} />
            )
          ) : (
            <LoadState error={found.error} onRetry={found.reload} />
          )
        ) : !root.data ? (
          <LoadState error={root.error} onRetry={root.reload} />
        ) : (
          <>
            {folders.length ? <FolderTiles folders={folders} /> : null}
            {files.length ? <Section title={t("files.atRoot")} rows={files.map((file) => ({ file }))} /> : null}
            {recent.data?.length ? (
              <Section
                title={t("files.recent")}
                rows={recent.data.slice(0, 20).map((e) => ({ file: e.file, path: e.path.map((p) => p.name).join(" / ") || undefined }))}
              />
            ) : null}
            {!folders.length && !files.length ? <EmptyState icon={FolderOpen} title={t("files.empty")} text={t("files.emptyHint")} /> : null}
          </>
        )}
      </ScrollView>
      {current ? (
        <FloatingButton
          icon={Upload}
          label={t("eventForm.addFile")}
          onPress={() => navigation.navigate("filesAdd", { spaceId: current.id, folderName: current.name })}
        />
      ) : null}
    </TabScreen>
  );
}

function FolderTiles({ folders }: { folders: SpaceFile[] }) {
  const { c } = useTheme();
  const navigation = useNavigation<NavigationProp<RootParams>>();
  const { current } = useSpace();
  return (
    <View style={styles.grid}>
      {folders.map((folder) => (
        <Pressable
          key={folder.id}
          accessibilityRole="button"
          onPress={() => openEntry(navigation, folder)}
          onLongPress={current ? () => navigation.navigate("fileMenu", { file: folder, spaceId: current.id }) : undefined}
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

function Section({ title, rows }: { title: string; rows: { file: SpaceFile; path?: string }[] }) {
  return (
    <View>
      <Text variant="small" tone="muted" style={styles.section}>
        {title}
      </Text>
      {rows.map((r, i) => (
        <FileRow key={r.file.id ?? i} file={r.file} path={r.path} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  // Room under the last row for the floating button.
  page: { paddingBottom: 96, gap: 12, flexGrow: 1 },
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
