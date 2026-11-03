import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

import { styleCache } from "../theme/themedStyles";
import { useTheme, useThemedStyles } from "../theme/useTheme";
import { feel } from "./haptics";
import { Text } from "./Text";

/** A segmented control (mockups 15 to 17): a sunken track, the chosen part raised in the accent. */
export function Segmented<K extends string>({
  options,
  value,
  onChange,
  style,
}: {
  options: { key: K; label: string }[];
  value: K;
  onChange: (key: K) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const { c, s } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={[styles.track, { backgroundColor: s.sunken }, style]}>
      {options.map(({ key, label }) => {
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
            style={[styles.part, on && { backgroundColor: c.acc, borderColor: s.edge }]}
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

const makeStyles = styleCache((shape) =>
  StyleSheet.create({
    track: { flexDirection: "row", padding: 4, borderRadius: shape.radius.m, marginHorizontal: 16 },
    part: { flex: 1, height: 36, alignItems: "center", justifyContent: "center", borderRadius: shape.radius.s + 2, borderWidth: shape.hairline, borderColor: "transparent" },
  }),
);
