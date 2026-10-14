import { StyleSheet, Switch, View } from "react-native";

import { useTheme } from "../../theme/useTheme";
import { Text } from "../../ui/Text";

/** A setting that is on or off: its name, a line saying what it does, and the switch. */
export function ToggleRow({
  title,
  text,
  value,
  onChange,
  disabled,
}: {
  title: string;
  text?: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  const { c, s } = useTheme();
  return (
    <View style={[styles.row, disabled && styles.off]}>
      <View style={styles.text}>
        <Text variant="bodyStrong">{title}</Text>
        {text ? (
          <Text variant="small" tone="muted">
            {text}
          </Text>
        ) : null}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{ true: c.ink, false: s.sunken }}
        accessibilityLabel={title}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10, minHeight: 56 },
  text: { flex: 1, minWidth: 0, gap: 2 },
  off: { opacity: 0.5 },
});
