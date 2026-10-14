import { CalendarDays } from "lucide-react-native";
import { useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";

import { useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { groupByDay, monthGrid, shiftAnchor } from "../../logic/agenda";
import { useTheme } from "../../theme/useTheme";
import { EmptyState } from "../../ui/States";
import { Text } from "../../ui/Text";
import type { AgendaData } from "./AgendaScreen";
import { calendarColor } from "./calendarColor";
import { DayEvents, useDayLabel } from "./DayEvents";
import { DayCell, PeriodHeader, useWeekLetters } from "./PeriodGrid";

/** A month (mockup 17): the grid with each day's dots, and the chosen day's events under it. */
export function MonthView({
  anchor,
  today,
  data,
  onAnchor,
  onChosen,
}: {
  anchor: string;
  today: string;
  data?: AgendaData;
  onAnchor: (day: string) => void;
  /** Told the day chosen, where a new event starts. */
  onChosen?: (day: string) => void;
}) {
  const { t } = useTranslation();
  const { c } = useTheme();
  const { locale, timeZone } = useLocale();
  const letters = useWeekLetters();
  const dayLabel = useDayLabel();
  const month = anchor.slice(0, 7);
  const grid = monthGrid(month);
  const [selected, setSelected] = useState(today.startsWith(month) ? today : `${month}-01`);
  const chosen = selected.startsWith(month) ? selected : `${month}-01`;
  useEffect(() => onChosen?.(chosen), [chosen, onChosen]);
  const byDay = useMemo(() => new Map(groupByDay(data?.occurrences ?? [], timeZone).map((d) => [d.day, d.items])), [data, timeZone]);
  const name = new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(`${month}-15T12:00:00Z`));

  return (
    <View style={styles.gap}>
      <PeriodHeader
        title={name.charAt(0).toLocaleUpperCase(locale) + name.slice(1)}
        onMove={(direction) => {
          const next = shiftAnchor("month", anchor, direction);
          onAnchor(next);
          setSelected(next);
        }}
      />
      <View style={styles.row}>
        {letters.map((letter, i) => (
          <Text key={i} variant="label" tone="muted" style={styles.letter}>
            {letter}
          </Text>
        ))}
      </View>
      {grid.map((week, w) => (
        <View key={w} style={styles.row}>
          {week.map((day, i) =>
            day ? (
              <DayCell
                key={day}
                day={day}
                selected={day === chosen}
                today={day === today}
                dots={[...new Set((byDay.get(day) ?? []).map((o) => calendarColor(data?.calendars.get(o.calendarId)?.color, c)))]}
                onPress={() => setSelected(day)}
              />
            ) : (
              <View key={`pad${i}`} style={styles.pad} />
            ),
          )}
        </View>
      ))}
      {data ? (
        byDay.get(chosen)?.length ? (
          <DayEvents day={chosen} today={today} items={byDay.get(chosen)!} data={data} />
        ) : (
          <View style={styles.dayEmpty}>
            <Text variant="smallStrong">{dayLabel(chosen, today)}</Text>
            <EmptyState size="compact" icon={CalendarDays} title={t("agenda.nothingThatDay")} />
          </View>
        )
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  dayEmpty: { gap: 4 },
  gap: { gap: 8 },
  row: { flexDirection: "row", gap: 2 },
  letter: { flex: 1, textAlign: "center" },
  pad: { flex: 1 },
});
