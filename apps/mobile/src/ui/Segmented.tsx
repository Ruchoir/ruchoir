import { Pressable, StyleSheet, View } from "react-native";

import { hairline, radius } from "../theme/tokens";
import { useTheme } from "../theme/useTheme";
import { Text } from "./Text";

/** A segmented control (mockups 15 to 17): a sunken track, the chosen part raised in the accent. */
export function Segmented<K extends string>({ options, value, onChange }: { options: { key: K; label: string }[]; value: K; onChange: (key: K) => void }) {
  const { c, s } = useTheme();
  return (
    <View style={[styles.track, { backgroundColor: s.sunken }]}>
      {options.map(({ key, label }) => {
        const on = key === value;
        return (
          <Pressable
            key={key}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => onChange(key)}
            style={[styles.part, on && { backgroundColor: c.acc, borderColor: c.ink }]}
          >
            <Text variant={on ? "smallStrong" : "small"} style={{ color: on ? c.onPastel : c.ink }}>
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: { flexDirection: "row", padding: 4, borderRadius: radius.m, marginHorizontal: 16 },
  part: { flex: 1, height: 36, alignItems: "center", justifyContent: "center", borderRadius: radius.s + 2, borderWidth: hairline, borderColor: "transparent" },
});
