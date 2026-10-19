import { getFilesView, getFolder, searchFiles, type FilesView, type SpaceFile, type ViewEntry } from "@ruchoir/client";
import { useNavigation, type NavigationProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Clock, Folder, FolderOpen, Inbox, SearchX, Star, Trash2, Upload } from "lucide-react-native";
import { useEffect, useState, type ReactNode } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";

import { useLoad } from "../../data/useLoad";
import { useReloadOn } from "../../data/useReloadOn";
import { key, useTranslation } from "../../i18n";
import { useWide } from "../../layout/useWide";
import type { RootParams } from "../../navigation/types";
import { fonts } from "../../theme/fonts";
import { useSpace } from "../../space/SpaceProvider";
import { hairline, radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { Chips } from "../../ui/Chips";
import { FloatingButton, useFloatingScroll } from "../../ui/FloatingButton";
import { feel } from "../../ui/haptics";
import { SearchField } from "../../ui/SearchField";
import { EmptyState, LoadState } from "../../ui/States";
import { SpaceSwitch, TabHeader } from "../../ui/TabHeader";
import { TabScreen } from "../../ui/TabScreen";
import { Text } from "../../ui/Text";
import { FileCardWide, FileRow, FolderCard, openEntry } from "./FileRow";
import { TrashList } from "./TrashList";
import { UploadStrip } from "./UploadStrip";

/**
 * The space's files (mockup 20): a search, the folders at the root as tiles, the files at the root,
 * and, as the web's views, what changed recently, the person's favourites and what was sent to them
 * in conversations; the trash at the bottom. "Add a file" puts files at the space's root.
 */
export function FilesScreen() {
  const { t } = useTranslation();
  const { c } = useTheme();
  const { current } = useSpace();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const floating = useFloatingScroll();
  const wide = useWide();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const space = current?.id;
  const root = useLoad(space ? `root:${space}` : null, (signal) => getFolder(space!, undefined, signal));
  const [view, setView] = useState<FilesView | "root" | "trash">("recent");
  // The trash stays loaded once seen, so coming back to it does not blink through its loading.
  const [trashSeen, setTrashSeen] = useState(false);
  const choose = (next: FilesView | "root" | "trash") => {
    if (next === "trash") setTrashSeen(true);
    setView(next);
  };
  const listed = useLoad(space && view !== "trash" && view !== "root" ? `view:${space}:${view}` : null, (signal) => getFilesView(space!, view as FilesView, signal), {
    keep: space,
  });
  const found = useLoad(space && debounced ? `search:${space}:${debounced}` : null, (signal) => searchFiles(space!, debounced, signal));
  useReloadOn((e) => e.type === "files" && e.spaceId === space, () => {
    root.reload();
    listed.reload();
  });

  /** Where a shared file was sent, and by whom. */
  const sharedLine = (e: ViewEntry) =>
    [e.sharedIn?.name ? (e.sharedIn.kind === "channel" ? `#${e.sharedIn.name}` : e.sharedIn.name) : null, e.sharedBy ? t("files.sentBy", { name: e.sharedBy }) : null]
      .filter(Boolean)
      .join(" · ") || undefined;
  const folders = root.data?.entries.filter((f) => f.kind === "folder") ?? [];
  const files = root.data?.entries.filter((f) => f.kind !== "folder") ?? [];


  const Row = wide ? FileCardWide : FileRow;
  const many = (children: ReactNode[]) => (wide ? <Grid>{children}</Grid> : <View>{children}</View>);

  return (
    <TabScreen>
      {wide ? null : <TabHeader title={t("tabs.files")} />}
      <ScrollView
        contentContainerStyle={wide ? styles.widePage : styles.page}
        onScroll={floating.onScroll}
        scrollEventThrottle={floating.scrollEventThrottle}
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={false}
            onRefresh={() => {
              feel("refresh");
              root.reload();
              listed.reload();
            }}
          />
        }
      >
        {wide ? (
          // The tablet mockup's head: the title and the space, the search and "Add a file" beside them.
          <View style={styles.wideHead}>
            <View style={styles.wideTitles}>
              <Text style={[styles.wideTitle, { color: c.ink }]}>{t("tabs.files")}</Text>
              <SpaceSwitch />
            </View>
            <SearchField value={query} onChange={setQuery} placeholder={t("files.search")} style={styles.wideSearch} />
            {current ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => navigation.navigate("filesAdd", { spaceId: current.id, folderName: current.name })}
                style={({ pressed }) => [styles.wideAdd, { borderColor: c.acc, backgroundColor: c.surface, shadowColor: c.acc }, pressed && { opacity: 0.7 }]}
              >
                <Upload size={18} color={c.ink} />
                <Text variant="bodyStrong">{t("eventForm.addFile")}</Text>
              </Pressable>
            ) : null}
          </View>
        ) : (
          <SearchField value={query} onChange={setQuery} placeholder={t("files.search")} />
        )}
        {space ? <UploadStrip spaceId={space} /> : null}
        {debounced ? (
          found.data ? (
            found.data.length ? (
              many(
                found.data.map((entry) => {
                  const path = entry.path.map((p) => p.name).join(" / ") || undefined;
                  return <Row key={entry.file.id} file={entry.file} line={path} path={path} />;
                }),
              )
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
            {folders.length ? (
              wide ? (
                <>
                  <Text style={[styles.wideLabel, { color: c.muted }]}>{t("files.folders")}</Text>
                  <Grid>
                    {folders.map((folder, i) => (
                      <FolderCard key={folder.id ?? i} folder={folder} index={i} />
                    ))}
                  </Grid>
                </>
              ) : (
                <FolderTiles folders={folders} />
              )
            ) : null}
            {/* The web's views, always there; the trash is the last of them. */}
            <Chips chips={VIEWS.map((v) => ({ key: v.key, label: t(v.label), icon: v.icon }))} value={view} onChange={choose} gutter={wide ? 0 : 16} />
            {trashSeen ? (
              <View style={view === "trash" ? undefined : styles.hidden}>
                <TrashList />
              </View>
            ) : null}
            {view === "trash" ? null : view === "root" ? (
              files.length ? (
                many(files.map((f, i) => <Row key={f.id ?? i} file={f} />))
              ) : folders.length ? (
                <EmptyState icon={FolderOpen} title={t("files.noRootFiles")} text={t("files.noRootFilesText")} />
              ) : (
                <EmptyState icon={FolderOpen} title={t("files.empty")} text={t("files.emptyHint")} />
              )
            ) : !listed.data ? (
              <LoadState error={listed.error} onRetry={listed.reload} />
            ) : listed.data.length ? (
              many(
                listed.data
                  .slice(0, 30)
                  .map((e, i) => <Row key={e.file.id ?? i} file={e.file} line={view === "shared" ? sharedLine(e) : undefined} path={pathOf(e)} />),
              )
            ) : view === "recent" && !folders.length && !files.length ? (
              // An empty space says it once, here, rather than "nothing recent" under it.
              <EmptyState icon={FolderOpen} title={t("files.empty")} text={t("files.emptyHint")} />
            ) : (
              <EmptyState icon={EMPTY[view].icon} title={t(EMPTY[view].title)} text={t(EMPTY[view].text)} />
            )}
          </>
        )}
      </ScrollView>
      {current && !wide ? (
        <FloatingButton
          compact={floating.compact}
          icon={Upload}
          label={t("eventForm.addFile")}
          onPress={() => navigation.navigate("filesAdd", { spaceId: current.id, folderName: current.name })}
        />
      ) : null}
    </TabScreen>
  );
}

const VIEWS = [
  { key: "recent", label: key("files.recent"), icon: Clock },
  { key: "root", label: key("files.atRoot"), icon: Folder },
  { key: "starred", label: key("files.favourites"), icon: Star },
  { key: "shared", label: key("files.sharedWithMe"), icon: Inbox },
  { key: "trash", label: key("files.trash"), icon: Trash2 },
] as const;

const EMPTY = {
  recent: { icon: Clock, title: key("files.noRecent"), text: key("files.noRecentText") },
  starred: { icon: Star, title: key("files.noFavourites"), text: key("files.noFavouritesText") },
  shared: { icon: Inbox, title: key("files.nothingShared"), text: key("files.nothingSharedText") },
} as const;

const pathOf = (e: ViewEntry) => e.path.map((p) => p.name).join(" / ") || undefined;

/** The tablet mockup's grids: cards of at least 200 points, 14 apart, as many as fit. */
function Grid({ children }: { children: ReactNode[] }) {
  const [width, setWidth] = useState(0);
  const columns = Math.max(1, Math.floor((width + 14) / (200 + 14)));
  const cell = width ? (width - 14 * (columns - 1)) / columns : 0;
  return (
    <View style={styles.wideGrid} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {width
        ? children.map((child, i) => (
            <View key={i} style={{ width: cell }}>
              {child}
            </View>
          ))
        : null}
    </View>
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
          onLongPress={
            current
              ? () => {
                  feel("menu");
                  navigation.navigate("fileMenu", { file: folder, spaceId: current.id });
                }
              : undefined
          }
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

const styles = StyleSheet.create({
  // Room under the last row for the floating button.
  // The tab's head stays above the page (it does not scroll away); the gap it had below it, here.
  page: { paddingTop: 12, paddingBottom: 96, gap: 12, flexGrow: 1 },
  // The tablet mockup's page: 1040 wide at most, 30/44/48 around it, 22 between blocks.
  widePage: { width: "100%", maxWidth: 1040, alignSelf: "center", paddingTop: 30, paddingHorizontal: 44, paddingBottom: 48, gap: 22 },
  wideHead: { flexDirection: "row", flexWrap: "wrap", alignItems: "flex-end", gap: 14 },
  wideTitles: { flex: 1, minWidth: 200, gap: 2 },
  wideTitle: { fontSize: 32, lineHeight: 38, fontFamily: fonts.sansBold, letterSpacing: -1.1 },
  wideSearch: { width: 300, marginHorizontal: 0 },
  wideAdd: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    height: 48,
    paddingHorizontal: 18,
    borderRadius: radius.m,
    borderWidth: 2,
    shadowOffset: { width: 3, height: 3 },
    shadowOpacity: 1,
    shadowRadius: 0,
    elevation: 3,
  },
  wideLabel: { fontSize: 14, lineHeight: 19, fontFamily: fonts.sansSemibold },
  wideGrid: { flexDirection: "row", flexWrap: "wrap", gap: 14 },
  hidden: { display: "none" },

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
