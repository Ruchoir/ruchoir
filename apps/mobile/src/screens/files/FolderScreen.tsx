import { isApiError } from "@ruchoir/client";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { FolderOpen, Upload } from "lucide-react-native";
import { useEffect } from "react";
import { FlatList, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useApi } from "../../api/useApi";
import { useLoad } from "../../data/useLoad";
import { useReloadOn } from "../../data/useReloadOn";
import { useTranslation } from "../../i18n";
import type { RootParams } from "../../navigation/types";
import { useSpace } from "../../space/SpaceProvider";
import { useTheme } from "../../theme/useTheme";
import { BackHeader } from "../../ui/BackHeader";
import { FloatingButton, useFloatingScroll } from "../../ui/FloatingButton";
import { EmptyState, LoadState } from "../../ui/States";
import { useToast } from "../../ui/Toast";
import { FileRow } from "./FileRow";
import { UploadStrip } from "./UploadStrip";

/** A folder's contents, folders first, as the web lists them; "Add a file" puts files in it. */
export function FolderScreen() {
  const { getFolder } = useApi();
  const { params } = useRoute<RouteProp<RootParams, "folder">>();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const floating = useFloatingScroll();
  const { t } = useTranslation();
  const { c } = useTheme();
  const { current } = useSpace();
  const toast = useToast();
  // A folder deleted meanwhile reads as `null`: the screen says so and goes back.
  const listing = useLoad(current ? `folder:${params.folderId}` : null, (signal) =>
    getFolder(current!.id, params.folderId, signal).catch((err: unknown) => {
      if (isApiError(err, 404)) return null;
      throw err;
    }),
  );
  const gone = listing.data === null;
  useEffect(() => {
    if (!gone) return;
    toast(t("files.folderGone"));
    navigation.goBack();
  }, [gone, navigation, t, toast]);
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
          onScroll={floating.onScroll}
          scrollEventThrottle={floating.scrollEventThrottle}
          data={entries}
          keyExtractor={(f, i) => f.id ?? String(i)}
          renderItem={({ item }) => <FileRow file={item} path={listing.data?.breadcrumb.map((b) => b.name).join(" / ")} />}
          ListEmptyComponent={<EmptyState icon={FolderOpen} title={t("files.folderEmpty")} text={t("files.folderEmptyHint")} />}
          ListHeaderComponent={current ? <UploadStrip spaceId={current.id} /> : null}
          contentContainerStyle={styles.list}
        />
      )}
      {current ? (
        <FloatingButton
          compact={floating.compact}
          icon={Upload}
          label={t("eventForm.addFile")}
          onPress={() => navigation.navigate("filesAdd", { spaceId: current.id, folderId: params.folderId, folderName: params.name })}
        />
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  // Room under the last row for the floating button.
  list: { flexGrow: 1, paddingBottom: 96 },
});
