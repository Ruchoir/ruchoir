import { getVersions, restoreVersion, versionDownloadUrl, type FileVersion } from "@ruchoir/client";
import { canManage } from "@ruchoir/client/filesLogic";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { History, RotateCcw } from "lucide-react-native";
import { Alert, Pressable, StyleSheet, View } from "react-native";

import { useLoad } from "../../data/useLoad";
import { useReloadOn } from "../../data/useReloadOn";
import { useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { fileSize } from "../../logic/format";
import type { RootParams } from "../../navigation/types";
import { useSession } from "../../session/SessionProvider";
import { useSpace } from "../../space/SpaceProvider";
import { hairline, radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { Sheet } from "../../ui/Sheet";
import { EmptyState, LoadState } from "../../ui/States";
import { Text } from "../../ui/Text";
import { useToast } from "../../ui/Toast";

/**
 * A file's history (the web's versions): each version with its date, who and size, opened with a
 * tap; who may manage the file brings an older one back, which becomes the newest.
 */
export function VersionsSheet() {
  const { params } = useRoute<RouteProp<RootParams, "fileVersions">>();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const { locale, timeZone } = useLocale();
  const toast = useToast();
  const { current } = useSpace();
  const { state } = useSession();
  const me = state.kind === "signedIn" ? state.user.id : undefined;
  const file = params.file;
  const manage = canManage(file, me, current?.role);
  const versions = useLoad(`versions:${file.id}`, (signal) => getVersions(file.id!, signal));
  // A version sent from elsewhere while the history is open joins it.
  useReloadOn((e) => e.type === "files", versions.reload);
  const when = (iso: string) => new Intl.DateTimeFormat(locale, { timeZone, day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

  const open = (v: FileVersion) =>
    navigation.navigate("fileViewer", {
      file: { id: `${file.id}-v${v.number}`, name: file.name, url: versionDownloadUrl(file.id!, v.id), mime: file.mimeType, sizeBytes: v.sizeBytes },
    });
  const restore = (v: FileVersion) =>
    Alert.alert(t("files.restoreVersion", { number: v.number }), undefined, [
      { text: t("compose.cancel"), style: "cancel" },
      {
        text: t("files.restore"),
        onPress: () =>
          void restoreVersion(file.id!, v.id).then(
            () => {
              versions.reload();
              toast(t("files.versionRestored", { number: v.number }));
            },
            () => toast(t("files.versionRestoreFailed")),
          ),
      },
    ]);

  return (
    <Sheet>
      <Text variant="heading">{t("files.versions")}</Text>
      <Text variant="small" tone="muted" numberOfLines={1}>
        {file.name}
      </Text>
      {!versions.data ? <LoadState error={versions.error} onRetry={versions.reload} /> : null}
      {versions.data && versions.data.length === 0 ? <EmptyState size="compact" icon={History} title={t("files.noVersions")} /> : null}
      {versions.data?.map((v) => (
        <Pressable
          key={v.id}
          accessibilityRole="button"
          onPress={() => open(v)}
          style={({ pressed }) => [styles.row, { borderBottomColor: c.line }, pressed && { opacity: 0.6 }]}
        >
          <View style={styles.grow}>
            <Text variant="bodyStrong">
              {t("files.versionNumber", { number: v.number })}
              {v.current ? ` · ${t("files.versionCurrent")}` : ""}
            </Text>
            <Text variant="tiny" tone="muted">
              {[when(v.createdAt), v.createdBy, fileSize(v.sizeBytes, locale)].filter(Boolean).join(" · ")}
            </Text>
          </View>
          {manage && !v.current ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("files.restoreVersion", { number: v.number })}
              hitSlop={8}
              onPress={() => restore(v)}
              style={({ pressed }) => [styles.restore, { borderColor: c.controlLine, backgroundColor: s.sunken }, pressed && { opacity: 0.6 }]}
            >
              <RotateCcw size={16} color={c.ink} />
              <Text variant="smallStrong">{t("files.restore")}</Text>
            </Pressable>
          ) : null}
        </Pressable>
      ))}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 12, borderBottomWidth: 1 },
  grow: { flex: 1, minWidth: 0, gap: 2 },
  restore: { flexDirection: "row", alignItems: "center", gap: 6, height: 34, paddingHorizontal: 10, borderRadius: radius.m, borderWidth: hairline },
});
