import { fileDownloadUrl, type SpaceFile } from "@ruchoir/client";
import { useNavigation, type NavigationProp } from "@react-navigation/native";
import { ChevronRight } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";

import { useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { listStamp } from "../../logic/format";
import type { RootParams } from "../../navigation/types";
import { useTheme } from "../../theme/useTheme";
import { FileIcon } from "../../ui/FileIcon";
import { Text } from "../../ui/Text";

/** Open what a row stands for: a folder is browsed, a file is shown. */
export function openEntry(navigation: NavigationProp<RootParams>, file: SpaceFile): void {
  if (!file.id) return;
  if (file.kind === "folder") navigation.navigate("folder", { folderId: file.id, name: file.name });
  else
    navigation.navigate("fileViewer", {
      file: { id: file.id, name: file.name, url: fileDownloadUrl(file.id), mime: file.mimeType, sizeBytes: file.sizeBytes },
    });
}

/** A file or a folder in a list (mockup 20): its icon, its name, who touched it last and when. */
export function FileRow({ file, line }: { file: SpaceFile; line?: string }) {
  const { t } = useTranslation();
  const { c } = useTheme();
  const { locale, timeZone } = useLocale();
  const navigation = useNavigation<NavigationProp<RootParams>>();
  const folder = file.kind === "folder";
  const stamp = file.updatedAt ? listStamp(file.updatedAt, new Date(), locale, timeZone) : null;
  const when = stamp ? (stamp.kind === "yesterday" ? t("time.yesterday") : stamp.text) : null;
  const meta = line ?? [file.modifiedBy ?? file.by, when].filter(Boolean).join(" · ");

  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => openEntry(navigation, file)}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.line }]}
    >
      <FileIcon name={file.name} mime={file.mimeType} folder={folder} />
      <View style={styles.text}>
        <Text variant="bodyStrong" numberOfLines={1}>
          {file.name}
        </Text>
        {meta ? (
          <Text variant="tiny" tone="muted" numberOfLines={1}>
            {meta}
          </Text>
        ) : null}
      </View>
      {folder ? <ChevronRight size={18} color={c.muted} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 10 },
  text: { flex: 1, minWidth: 0, gap: 2 },
});
