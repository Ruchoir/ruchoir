import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { X } from "lucide-react-native";
import { useEffect } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { useTranslation } from "../../i18n";
import type { QueueItem } from "../../logic/uploadQueue";
import type { RootParams } from "../../navigation/types";
import { useTheme } from "../../theme/useTheme";
import { FileIcon } from "../../ui/FileIcon";
import { Sheet } from "../../ui/Sheet";
import { Text } from "../../ui/Text";
import { useUploads } from "../../uploads/UploadsProvider";

/** Each file on its way: how far it is, what failed (a tap sends it again), a cross to stop it. */
export function UploadsSheet() {
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const uploads = useUploads();
  const items = uploads.queue.filter((i) => i.state !== "done");
  useEffect(() => {
    if (items.length === 0) navigation.goBack();
  }, [items.length, navigation]);
  const status = (i: QueueItem) => {
    if (i.state === "asking") return t("files.nameTaken");
    if (i.state === "waiting") return t("files.uploadQueued");
    if (i.state === "sending") return t("attach.uploading", { percent: i.file.size ? Math.min(99, Math.round((i.sent / i.file.size) * 100)) : 0 });
    if (i.error === "tooLarge") return t("files.uploadTooLarge");
    if (i.error === "forbidden") return t("files.uploadForbidden");
    return `${t("files.uploadNetwork")} · ${t("attach.failed")}`;
  };
  return (
    <Sheet>
      <Text variant="heading">{t("files.uploadsLabel")}</Text>
      {items.map((i) => (
        <Pressable
          key={i.key}
          accessibilityRole="button"
          disabled={i.state !== "failed" && i.state !== "asking"}
          onPress={() => (i.state === "asking" ? navigation.navigate("uploadConflict") : uploads.retry(i.key))}
          style={({ pressed }) => [styles.row, { borderBottomColor: c.line }, pressed && { opacity: 0.6 }]}
        >
          <FileIcon name={i.name} mime={i.file.mime} />
          <View style={styles.grow}>
            <Text variant="bodyStrong" numberOfLines={1}>
              {i.name}
            </Text>
            <Text variant="tiny" tone={i.state === "failed" ? "danger" : "muted"} numberOfLines={2}>
              {status(i)}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("files.cancelUpload", { name: i.name })}
            hitSlop={10}
            onPress={() => uploads.remove(i.key)}
            style={({ pressed }) => [styles.cross, { backgroundColor: s.sunken }, pressed && { opacity: 0.6 }]}
          >
            <X size={14} color={c.ink} />
          </Pressable>
        </Pressable>
      ))}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10, borderBottomWidth: 1 },
  grow: { flex: 1, minWidth: 0 },
  cross: { width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center" },
});
