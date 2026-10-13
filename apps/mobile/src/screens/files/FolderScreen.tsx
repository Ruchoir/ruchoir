import { getFolder } from "@ruchoir/client";
import { useRoute, type RouteProp } from "@react-navigation/native";
import { FolderOpen } from "lucide-react-native";
import { FlatList, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useLoad } from "../../data/useLoad";
import { useReloadOn } from "../../data/useReloadOn";
import { useTranslation } from "../../i18n";
import type { RootParams } from "../../navigation/types";
import { useSpace } from "../../space/SpaceProvider";
import { useTheme } from "../../theme/useTheme";
import { BackHeader } from "../../ui/BackHeader";
import { EmptyState, LoadState } from "../../ui/States";
import { FileRow } from "./FileRow";

/** A folder's contents, folders first, as the web lists them. */
export function FolderScreen() {
  const { params } = useRoute<RouteProp<RootParams, "folder">>();
  const { t } = useTranslation();
  const { c } = useTheme();
  const { current } = useSpace();
  const listing = useLoad(current ? `folder:${params.folderId}` : null, (signal) => getFolder(current!.id, params.folderId, signal));
  useReloadOn((e) => e.type === "files", listing.reload);
  const entries = [...(listing.data?.entries ?? [])].sort(
    (a, b) => Number(b.kind === "folder") - Number(a.kind === "folder") || a.name.localeCompare(b.name),
  );

  return (
    <SafeAreaView edges={["top"]} style={[styles.fill, { backgroundColor: c.bg }]}>
      <BackHeader title={params.name} subtitle={listing.data?.breadcrumb.map((b) => b.name).join(" / ")} />
      {!listing.data ? (
        <LoadState error={listing.error} onRetry={listing.reload} />
      ) : (
        <FlatList
          data={entries}
          keyExtractor={(f, i) => f.id ?? String(i)}
          renderItem={({ item }) => <FileRow file={item} />}
          ListEmptyComponent={<EmptyState icon={FolderOpen} title={t("files.folderEmpty")} text={t("files.folderEmptyHint")} />}
          contentContainerStyle={styles.list}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  list: { flexGrow: 1 },
});
