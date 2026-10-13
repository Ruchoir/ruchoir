import { useNavigation } from "@react-navigation/native";
import { ChevronLeft } from "lucide-react-native";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { useTranslation } from "../i18n";
import { useTheme } from "../theme/useTheme";
import { Text } from "./Text";

/** The head of a pushed screen (mockup 13): back, an optional picture, the title and a line under it. */
export function BackHeader({ title, subtitle, leading }: { title: string; subtitle?: string; leading?: ReactNode }) {
  const navigation = useNavigation();
  const { t } = useTranslation();
  const { c } = useTheme();
  return (
    <View style={styles.row}>
      <Pressable accessibilityRole="button" accessibilityLabel={t("common.back")} onPress={() => navigation.goBack()} style={styles.back}>
        <ChevronLeft size={26} color={c.ink} />
      </Pressable>
      {leading}
      <View style={styles.text}>
        <Text variant="heading" numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="tiny" tone="muted" numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 8, paddingVertical: 6, minHeight: 56 },
  back: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  text: { flex: 1, minWidth: 0 },
});
