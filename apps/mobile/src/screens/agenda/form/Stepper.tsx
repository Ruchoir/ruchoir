import { Minus, Plus } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";

import { useTranslation } from "../../../i18n";
import { hairline, radius } from "../../../theme/tokens";
import { useTheme } from "../../../theme/useTheme";
import { Text } from "../../../ui/Text";

/** A small number set with − and +, between `min` and `max`: no keyboard over a sheet for a count. */
export function Stepper({ value, min, max, onChange, label }: { value: number; min: number; max: number; onChange: (next: number) => void; label: string }) {
  const { t } = useTranslation();
  const { c } = useTheme();
  const button = (delta: -1 | 1) => {
    const disabled = delta < 0 ? value <= min : value >= max;
    const Icon = delta < 0 ? Minus : Plus;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${delta < 0 ? t("eventForm.less") : t("eventForm.more")} (${label})`}
        accessibilityState={{ disabled }}
        disabled={disabled}
        hitSlop={6}
        onPress={() => onChange(Math.max(min, Math.min(max, value + delta)))}
        style={({ pressed }) => [styles.button, { borderColor: c.controlLine }, (pressed || disabled) && { opacity: 0.4 }]}
      >
        <Icon size={16} color={c.ink} />
      </Pressable>
    );
  };
  return (
    <View style={styles.row} accessibilityLabel={label}>
      {button(-1)}
      <Text variant="bodyStrong" style={styles.value}>
        {value}
      </Text>
      {button(1)}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  button: { width: 36, height: 36, borderRadius: radius.m, borderWidth: hairline, alignItems: "center", justifyContent: "center" },
  value: { minWidth: 28, textAlign: "center" },
});
