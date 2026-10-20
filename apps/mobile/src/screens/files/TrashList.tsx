import { emptyTrash, eraseFile, getInstanceCapabilities, getTrash, restoreFile, type TrashEntry } from "@ruchoir/client";
import { RotateCcw, Trash2 } from "lucide-react-native";
import { Alert, Pressable, StyleSheet, View } from "react-native";

import { useLoad } from "../../data/useLoad";
import { useReloadOn } from "../../data/useReloadOn";
import { useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { useSpace } from "../../space/SpaceProvider";
import { hairline, radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { Button } from "../../ui/Button";
import { FileIcon } from "../../ui/FileIcon";
import { feel } from "../../ui/haptics";
import { EmptyState, LoadState } from "../../ui/States";
import { Text } from "../../ui/Text";
import { useToast } from "../../ui/Toast";

/**
 * The space's trash, as the Files tab's last view (the web's): what was deleted, where it was, when
 * and by whom, each restored by who may, or erased for good with a long press; owners and
 * administrators empty it after a question. How
 * long it keeps things is the instance's.
 */
export function TrashList() {
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const { locale, timeZone } = useLocale();
  const toast = useToast();
  const { current } = useSpace();
  const space = current?.id;
  const trash = useLoad(space ? `trash:${space}` : null, (signal) => getTrash(space!, signal));
  const caps = useLoad("capabilities", (signal) => getInstanceCapabilities(signal));
  useReloadOn((e) => e.type === "files" && e.spaceId === space, trash.reload);
  const admin = current?.role === "owner" || current?.role === "admin";
  const when = (iso: string) => new Intl.DateTimeFormat(locale, { timeZone, day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

  const restore = (entry: TrashEntry) =>
    void restoreFile(entry.file.id!).then(
      (done) => {
        trash.reload();
        toast(
          done.restoredToRoot
            ? t("files.restoredToRoot", { name: entry.file.name })
            : t("files.restoredInto", { folder: entry.originalFolderName ?? current?.name ?? "" }),
        );
      },
      () => toast(t("files.restoreFailed"), "failure"),
    );
  const empty = () => {
    const count = trash.data?.length ?? 0;
    Alert.alert(t("files.emptyTrashTitle"), t("files.emptyTrashBody", { count }), [
      { text: t("compose.cancel"), style: "cancel" },
      {
        text: t("files.emptyTrash"),
        style: "destructive",
        onPress: () =>
          void emptyTrash(space!).then(
            () => trash.reload(),
            () => toast(t("files.actionFailed"), "failure"),
          ),
      },
    ]);
  };
  // One entry for good, from a long press on it: what the web's menu offers next to restoring.
  const erase = (entry: TrashEntry) => {
    feel("menu");
    Alert.alert(t("files.eraseTitle", { name: entry.file.name }), t("files.eraseBody"), [
      { text: t("compose.cancel"), style: "cancel" },
      {
        text: t("spaceAdmin.deleteConfirm"),
        style: "destructive",
        onPress: () =>
          void eraseFile(entry.file.id!).then(
            () => {
              toast(t("files.erased"));
              trash.reload();
            },
            () => toast(t("files.eraseFailed"), "failure"),
          ),
      },
    ]);
  };
  const retention = caps.data?.trashRetentionDays;

  if (!trash.data) return <LoadState error={trash.error} onRetry={trash.reload} />;
  if (trash.data.length === 0) return <EmptyState icon={Trash2} title={t("files.trashEmpty")} text={t("files.trashEmptyText")} />;
  return (
    <View>
      {trash.data.map((item, i) => (
        <Pressable
          key={item.file.id ?? i}
          onLongPress={item.canManage ? () => erase(item) : undefined}
          accessibilityHint={item.canManage ? t("files.eraseHint") : undefined}
          style={[styles.row, { borderBottomColor: c.line }]}
        >
          <FileIcon name={item.file.name} mime={item.file.mimeType} folder={item.file.kind === "folder"} />
          <View style={styles.grow}>
            <Text variant="bodyStrong" numberOfLines={1}>
              {item.file.name}
            </Text>
            <Text variant="tiny" tone="muted" numberOfLines={2}>
              {[item.originalFolderName ?? t("files.root"), when(item.deletedAt), item.deletedBy ? `${t("files.deletedBy")} ${item.deletedBy}` : null]
                .filter(Boolean)
                .join(" · ")}
            </Text>
          </View>
          {item.canManage ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${t("files.restore")} ${item.file.name}`}
              hitSlop={8}
              onPress={() => restore(item)}
              style={({ pressed }) => [styles.restore, { borderColor: c.controlLine, backgroundColor: s.sunken }, pressed && { opacity: 0.6 }]}
            >
              <RotateCcw size={16} color={c.ink} />
              <Text variant="smallStrong">{t("files.restore")}</Text>
            </Pressable>
          ) : null}
        </Pressable>
      ))}
      <View style={styles.foot}>
        <Text variant="tiny" tone="muted">
          {retention ? t("files.trashRetention", { count: retention }) : t("files.trashKept")}
        </Text>
        {admin ? <Button variant="secondary" label={t("files.emptyTrash")} onPress={empty} /> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1 },
  grow: { flex: 1, minWidth: 0, gap: 2 },
  restore: { flexDirection: "row", alignItems: "center", gap: 6, height: 34, paddingHorizontal: 10, borderRadius: radius.m, borderWidth: hairline },
  foot: { gap: 12, paddingHorizontal: 16, paddingTop: 16 },
});
