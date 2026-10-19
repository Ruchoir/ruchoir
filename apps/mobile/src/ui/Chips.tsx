import type { LucideIcon } from "lucide-react-native";
import { Pressable, ScrollView, StyleSheet } from "react-native";

import { hairline } from "../theme/tokens";
import { useTheme } from "../theme/useTheme";
import { feel } from "./haptics";
import { Text } from "./Text";

export type Chip<K extends string> = { key: K; label: string; icon?: LucideIcon; count?: number };

/**
 * A row of pills (the filters of mockup 12, the tabs of mockup 13): the chosen one tinted with the
 * accent and outlined in ink, the others outlined in grey.
 */
export function Chips<K extends string>({
  chips,
  value,
  onChange,
  gutter = 16,
}: {
  chips: Chip<K>[];
  value: K;
  onChange: (key: K) => void;
  /** The room on each side: a page with its own margin (a tablet) wants none. */
  gutter?: number;
}) {
  const { c, s } = useTheme();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.strip} contentContainerStyle={[styles.row, { paddingHorizontal: gutter }]}>
      {chips.map(({ key, label, icon: Icon, count }) => {
        const on = key === value;
        return (
          <Pressable
            key={key}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => {
              if (!on) feel("choice");
              onChange(key);
            }}
            style={[styles.chip, { borderColor: on ? c.ink : c.lineStrong, backgroundColor: on ? s.selected : c.surface }]}
          >
            {Icon ? <Icon size={16} color={c.ink} /> : null}
            <Text variant={on ? "smallStrong" : "small"}>{label}</Text>
            {count ? (
              <Text variant="label" tone="muted" style={styles.count}>
                {String(count)}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  // A horizontal ScrollView grows by default and would take half of a screen's height.
  strip: { flexGrow: 0 },
  row: { gap: 8, paddingHorizontal: 16, paddingVertical: 4 },
  chip: { flexDirection: "row", alignItems: "center", gap: 6, height: 36, paddingHorizontal: 14, borderRadius: 18, borderWidth: hairline },
  count: { fontSize: 11, lineHeight: 13, marginTop: -6 },
});
