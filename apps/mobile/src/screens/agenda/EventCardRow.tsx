import { Pressable, StyleSheet, View } from "react-native";

import { fonts } from "../../theme/fonts";
import { hairline, mix, radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { Text } from "../../ui/Text";

/**
 * An event in a list (mockups 15 to 17): a tinted card with the event's colour as a bar on its edge,
 * the time in the monospace face, the title and a line of where and with whom.
 */
export function EventCardRow({
  time,
  allDay,
  title,
  meta,
  color,
  onPress,
}: {
  time: string;
  /** The time column holds a word ("All day") rather than a time: smaller, on up to two lines. */
  allDay?: boolean;
  title: string;
  meta?: string;
  color: string;
  onPress: () => void;
}) {
  const { c } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: mix(color, c.surface, 0.18), borderColor: mix(color, c.surface, 0.6) },
        pressed && { opacity: 0.7 },
      ]}
    >
      <View style={[styles.bar, { backgroundColor: color }]} />
      <Text variant={allDay ? "tiny" : "small"} numberOfLines={allDay ? 2 : 1} style={styles.time}>
        {time}
      </Text>
      <View style={styles.text}>
        <Text variant="bodyStrong" numberOfLines={2}>
          {title}
        </Text>
        {meta ? (
          <Text variant="tiny" tone="body" numberOfLines={2}>
            {meta}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingVertical: 12, paddingRight: 12, paddingLeft: 16, borderRadius: radius.m, borderWidth: hairline, overflow: "hidden" },
  bar: { position: "absolute", left: 6, top: 10, bottom: 10, width: 3, borderRadius: 2 },
  time: { fontFamily: fonts.mono, width: 58, paddingTop: 1 },
  text: { flex: 1, minWidth: 0, gap: 2 },
});
