import { Image } from "expo-image";
import { RotateCcw, X } from "lucide-react-native";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import { useTranslation } from "../i18n";
import { useLocale } from "../i18n/useLocale";
import { fileSize } from "../logic/format";
import { hairline, radius } from "../theme/tokens";
import { useTheme } from "../theme/useTheme";
import { FileIcon } from "../ui/FileIcon";
import { Text } from "../ui/Text";
import type { Attachments } from "./useAttachments";

/**
 * The files waiting to go, above the bar: a thumbnail or the file's icon, its name, how far the
 * upload is (a bar along the bottom), and a cross to take it out. A failed one says so and retries
 * on a tap.
 */
export function PendingFiles({ attachments }: { attachments: Attachments }) {
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const { locale } = useLocale();
  if (attachments.files.length === 0) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.scroll} contentContainerStyle={styles.row}>
      {attachments.files.map((f) => {
        const failed = f.state === "failed";
        const progress = f.size > 0 ? Math.min(1, f.sent / f.size) : 0;
        const line = failed
          ? f.tooLarge
            ? t("attach.tooLargeShort")
            : t("attach.failed")
          : f.state === "uploading"
            ? t("attach.uploading", { percent: Math.round(progress * 100) })
            : fileSize(f.size, locale);
        return (
          <Pressable
            key={f.key}
            disabled={!failed || f.tooLarge}
            onPress={() => attachments.retry(f.key)}
            accessibilityLabel={`${f.name}, ${line}`}
            style={[styles.chip, { borderColor: failed ? s.danger : c.line, backgroundColor: c.surface }]}
          >
            {f.uri && f.mime.startsWith("image/") ? (
              <Image source={{ uri: f.uri }} style={styles.thumb} contentFit="cover" />
            ) : (
              <FileIcon name={f.name} size={36} />
            )}
            <View style={styles.text}>
              <Text variant="smallStrong" numberOfLines={1}>
                {f.name}
              </Text>
              <View style={styles.status}>
                {failed && !f.tooLarge ? <RotateCcw size={12} color={s.danger} /> : null}
                <Text variant="tiny" tone={failed ? "danger" : "muted"} numberOfLines={1}>
                  {line}
                </Text>
              </View>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("attach.remove", { name: f.name })}
              hitSlop={8}
              onPress={() => attachments.remove(f.key)}
              style={[styles.remove, { backgroundColor: s.sunken }]}
            >
              <X size={14} color={c.ink} />
            </Pressable>
            {f.state === "uploading" ? (
              <View style={[styles.track, { backgroundColor: c.line }]}>
                <View style={[styles.bar, { width: `${Math.max(4, progress * 100)}%`, backgroundColor: c.ink }]} />
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 0 },
  row: { gap: 8, paddingHorizontal: 16, paddingTop: 8 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    width: 220,
    height: 56,
    paddingLeft: 8,
    paddingRight: 6,
    borderWidth: hairline,
    borderRadius: radius.m,
    overflow: "hidden",
  },
  thumb: { width: 36, height: 36, borderRadius: radius.s },
  text: { flex: 1, minWidth: 0 },
  status: { flexDirection: "row", alignItems: "center", gap: 4 },
  remove: { width: 24, height: 24, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  track: { position: "absolute", left: 0, right: 0, bottom: 0, height: 3 },
  bar: { height: 3 },
});
