import { fileExtension } from "@ruchoir/client";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { useLocale } from "../i18n/useLocale";
import { fileSize } from "../logic/format";
import { hairline, radius } from "../theme/tokens";
import { useTheme } from "../theme/useTheme";
import { FileIcon } from "./FileIcon";
import { Text } from "./Text";

/** A file joined to a message (mockup 13): its icon, its name, its type and size. */
export function FileCard({
  name,
  sizeBytes,
  onPress,
  trailing,
}: {
  name: string;
  sizeBytes?: number;
  onPress?: () => void;
  /** A mark at the end of the card (the download arrow of an event's files). */
  trailing?: ReactNode;
}) {
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
      {trailing}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: "row", alignItems: "center", gap: 12, padding: 10, borderRadius: radius.m, borderWidth: hairline, maxWidth: 300 },
  text: { flex: 1, minWidth: 0 },
});
