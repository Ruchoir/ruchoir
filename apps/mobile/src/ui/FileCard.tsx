import { fileExtension } from "@ruchoir/client";
import { Pressable, StyleSheet, View } from "react-native";

import { useLocale } from "../i18n/useLocale";
import { fileSize } from "../logic/format";
import { hairline, radius } from "../theme/tokens";
import { useTheme } from "../theme/useTheme";
import { FileIcon } from "./FileIcon";
import { Text } from "./Text";

/** A file joined to a message (mockup 13): its icon, its name, its type and size. */
export function FileCard({ name, sizeBytes, onPress }: { name: string; sizeBytes?: number; onPress?: () => void }) {
  const { c } = useTheme();
  const { locale } = useLocale();
  const meta = [fileExtension(name).toUpperCase(), sizeBytes !== undefined ? fileSize(sizeBytes, locale) : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [styles.card, { borderColor: c.line, backgroundColor: c.surface }, pressed && { opacity: 0.7 }]}
    >
      <FileIcon name={name} size={36} />
      <View style={styles.text}>
        <Text variant="smallStrong" numberOfLines={1}>
          {name}
        </Text>
        {meta ? (
          <Text variant="tiny" tone="muted">
            {meta}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: "row", alignItems: "center", gap: 12, padding: 10, borderRadius: radius.m, borderWidth: hairline, maxWidth: 300 },
  text: { flexShrink: 1 },
});
