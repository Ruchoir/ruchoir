import { X } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";

import { useTranslation } from "../i18n";
import { useTheme } from "../theme/useTheme";
import { Text } from "./Text";

/** The head of a screen that slides up over the app (a form): its title and a way to close it. */
export function SheetHeader({ title, onClose }: { title: string; onClose: () => void }) {
  const { t } = useTranslation();
  const { c, s } = useTheme();
  return (
    <View style={styles.row}>
      <Text variant="heading" style={styles.title} accessibilityRole="header">
        {title}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("common.close")}
        hitSlop={8}
        onPress={onClose}
        style={({ pressed }) => [styles.close, { backgroundColor: s.sunken }, pressed && { opacity: 0.6 }]}
      >
        <X size={18} color={c.ink} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingTop: 20, paddingBottom: 12 },
  title: { flex: 1 },
  close: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
});
