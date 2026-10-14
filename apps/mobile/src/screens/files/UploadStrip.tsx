import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { AlertTriangle, ChevronRight, Upload } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";

import { useTranslation } from "../../i18n";
import { progress } from "../../logic/uploadQueue";
import type { RootParams } from "../../navigation/types";
import { hairline, mix, radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { Text } from "../../ui/Text";
import { useUploads } from "../../uploads/UploadsProvider";

/** What is on its way to the space, above its files: how far it is, or what failed or asks. A tap opens the uploads. */
export function UploadStrip({ spaceId }: { spaceId: string }) {
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const { queue } = useUploads();
  const mine = queue.filter((i) => i.spaceId === spaceId);
  const p = progress(mine);
  if (p.count === 0) return null;
  const asking = mine.some((i) => i.state === "asking");
  const going = p.count - p.failed - (asking ? mine.filter((i) => i.state === "asking").length : 0);
  const percent = p.total ? Math.min(99, Math.round((p.sent / p.total) * 100)) : 0;
  const text = asking
    ? t("files.nameTaken")
    : going > 0
      ? t("files.uploadingCount", { count: going, percent })
      : t("files.uploadsFailed", { count: p.failed });
  const warn = asking || going === 0;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("files.uploadsLabel")}
      onPress={() => navigation.navigate(asking ? "uploadConflict" : "uploads")}
      style={({ pressed }) => [
        styles.strip,
        { borderColor: c.line, backgroundColor: warn ? mix(c.sun, c.surface, 0.3) : c.surface },
        pressed && { opacity: 0.7 },
      ]}
    >
      {warn ? <AlertTriangle size={18} color={c.ink} /> : <Upload size={18} color={c.ink} />}
      <View style={styles.grow}>
        <Text variant="smallStrong" numberOfLines={1}>
          {text}
        </Text>
        {!warn ? (
          <View style={[styles.bar, { backgroundColor: s.sunken }]}>
            <View style={[styles.fill, { width: `${percent}%`, backgroundColor: c.acc }]} />
          </View>
        ) : null}
      </View>
      <ChevronRight size={18} color={c.muted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  strip: { flexDirection: "row", alignItems: "center", gap: 10, marginHorizontal: 16, padding: 12, borderRadius: radius.m, borderWidth: hairline },
  grow: { flex: 1, gap: 6 },
  bar: { height: 4, borderRadius: 2, overflow: "hidden" },
  fill: { height: 4 },
});
