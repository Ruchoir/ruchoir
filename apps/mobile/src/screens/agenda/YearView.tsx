import { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { useLocale } from "../../i18n/useLocale";
import { groupByDay, monthGrid, shiftAnchor } from "../../logic/agenda";
import { usePrefs } from "../../prefs/store";
import { tokens } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { Text } from "../../ui/Text";
import type { AgendaData } from "./AgendaScreen";
import { PeriodHeader, useWeekLetters } from "./PeriodGrid";

/** Today's number, white on the alarm colour by day and by night. */
const ON_ALARM = tokens.sky.onInk;

/** Beyond this many events, a day's mark is filled rather than a dot, as on the web. */
const BUSY = 3;

/**
 * The year as twelve small months, as the web's `YearView`: a day with events carries a dot, a full
 * one (more than three) a filled mark, today is in the alarm colour. A day, or a month's name, opens
 * that month (`onPick`).
 */
export function YearView({
  anchor,
  today,
  data,
  columns,
  onAnchor,
  onPick,
}: {
  anchor: string;
  today: string;
  data?: AgendaData;
  /** Months side by side: two on a phone, more on a tablet. */
  columns: number;
  onAnchor: (day: string) => void;
  onPick: (day: string) => void;
}) {
  const { c } = useTheme();
  const { locale, timeZone } = useLocale();
  const { weekStart } = usePrefs();
  const letters = useWeekLetters();
  const year = anchor.slice(0, 4);
  const counts = useMemo(() => new Map(groupByDay(data?.occurrences ?? [], timeZone).map((d) => [d.day, d.items.length])), [data, timeZone]);
  const monthName = new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: "long" });
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);

  return (
    <View style={styles.gap}>
      <PeriodHeader title={year} onMove={(direction) => onAnchor(shiftAnchor("year", anchor, direction))} />
      <View style={styles.grid}>
        {months.map((month) => {
          const name = monthName.format(new Date(`${month}-15T12:00:00Z`));
          return (
            <View key={month} style={[styles.month, { width: `${100 / columns}%` }]}>
              <Pressable accessibilityRole="button" onPress={() => onPick(`${month}-01`)} hitSlop={4}>
                <Text variant="smallStrong" style={month === today.slice(0, 7) ? { color: c.alarm } : undefined}>
                  {name.charAt(0).toLocaleUpperCase(locale) + name.slice(1)}
                </Text>
              </Pressable>
              <View style={styles.row}>
                {letters.map((letter, i) => (
                  <Text key={i} variant="tiny" tone="muted" style={styles.cell}>
                    {letter}
                  </Text>
                ))}
              </View>
              {monthGrid(month, weekStart).map((week, w) => (
                <View key={w} style={styles.row}>
                  {week.map((day, i) => {
                    if (!day) return <View key={`pad${i}`} style={styles.cell} />;
                    const count = counts.get(day) ?? 0;
                    const isToday = day === today;
                    return (
                      <Pressable key={day} accessibilityRole="button" accessibilityLabel={day} onPress={() => onPick(day)} style={styles.cell}>
                        <View style={[styles.number, count > BUSY && { backgroundColor: c.acc }, isToday && { backgroundColor: c.alarm }]}>
                          <Text variant="tiny" style={{ color: isToday ? ON_ALARM : count > BUSY ? c.onPastel : c.ink }}>
                            {String(Number(day.slice(8)))}
                          </Text>
                        </View>
                        <View style={[styles.dot, { backgroundColor: count > 0 && count <= BUSY ? c.ink : "transparent" }]} />
                      </Pressable>
                    );
                  })}
                </View>
              ))}
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  gap: { gap: 8 },
  grid: { flexDirection: "row", flexWrap: "wrap", rowGap: 16 },
  month: { paddingHorizontal: 6, gap: 2 },
  row: { flexDirection: "row" },
  cell: { flex: 1, alignItems: "center", textAlign: "center" },
  number: { width: 20, height: 20, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  dot: { width: 3, height: 3, borderRadius: 2, marginTop: 1 },
});
