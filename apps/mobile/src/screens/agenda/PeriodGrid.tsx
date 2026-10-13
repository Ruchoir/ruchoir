import { ChevronLeft, ChevronRight } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";

import { useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { hairline, radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { Text } from "../../ui/Text";

/** The period's name with the arrows that move it. */
export function PeriodHeader({ title, onMove }: { title: string; onMove: (direction: 1 | -1) => void }) {
  const { t } = useTranslation();
  const { c } = useTheme();
  return (
    <View style={styles.header}>
      <Text variant="bodyStrong" style={styles.flex}>
        {title}
      </Text>
      <Pressable accessibilityRole="button" accessibilityLabel={t("agenda.previous")} onPress={() => onMove(-1)} style={styles.arrow}>
        <ChevronLeft size={20} color={c.ink} />
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={t("agenda.next")} onPress={() => onMove(1)} style={styles.arrow}>
        <ChevronRight size={20} color={c.ink} />
      </Pressable>
    </View>
  );
}

/** The narrow weekday letters, Monday first ("L M M J V S D"). */
export function useWeekLetters(): string[] {
  const { locale } = useLocale();
  const format = new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "narrow" });
  // 2026-06-15 is a Monday.
  return Array.from({ length: 7 }, (_, i) => format.format(new Date(Date.UTC(2026, 5, 15 + i, 12))));
}

/**
 * A day in a week strip or a month grid: its number, the dots of its events (one per calendar
 * colour, three at most), the chosen day raised in the accent, today in bold.
 */
export function DayCell({
  day,
  selected,
  today,
  dots,
  onPress,
}: {
  day: string;
  selected: boolean;
  today: boolean;
  dots: string[];
  onPress: () => void;
}) {
  const { c } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.cell, selected && { backgroundColor: c.acc, borderColor: c.ink }]}
    >
      <Text variant={today || selected ? "bodyStrong" : "body"} style={{ color: selected ? c.onPastel : c.ink }}>
        {String(Number(day.slice(8)))}
      </Text>
      <View style={styles.dots}>
        {dots.slice(0, 3).map((color, i) => (
          <View key={i} style={[styles.dot, { backgroundColor: selected ? c.onPastel : color }]} />
        ))}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 4 },
  flex: { flex: 1 },
  arrow: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  cell: { flex: 1, minHeight: 50, alignItems: "center", justifyContent: "center", gap: 3, borderRadius: radius.m, borderWidth: hairline, borderColor: "transparent" },
  dots: { flexDirection: "row", gap: 3, height: 5 },
  dot: { width: 5, height: 5, borderRadius: 3 },
});
