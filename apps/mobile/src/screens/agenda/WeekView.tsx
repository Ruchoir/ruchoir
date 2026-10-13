import { CalendarDays } from "lucide-react-native";
import { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";

import { useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { groupByDay, shiftAnchor, weekOf } from "../../logic/agenda";
import { useTheme } from "../../theme/useTheme";
import { EmptyState } from "../../ui/States";
import { Text } from "../../ui/Text";
import type { AgendaData } from "./AgendaScreen";
import { calendarColor } from "./calendarColor";
import { DayEvents, useDayLabel } from "./DayEvents";
import { DayCell, PeriodHeader, useWeekLetters } from "./PeriodGrid";

/** A week (mockup 16): its seven days with their dots, and the chosen day's events under them. */
export function WeekView({ anchor, today, data, onAnchor }: { anchor: string; today: string; data?: AgendaData; onAnchor: (day: string) => void }) {
  const { t } = useTranslation();
  const { c } = useTheme();
  const { locale, timeZone } = useLocale();
  const letters = useWeekLetters();
  const dayLabel = useDayLabel();
  const week = weekOf(anchor);
  const [selected, setSelected] = useState(week.includes(today) ? today : week[0]);
  const chosen = week.includes(selected) ? selected : week[0];
  const byDay = useMemo(() => new Map(groupByDay(data?.occurrences ?? [], timeZone).map((d) => [d.day, d.items])), [data, timeZone]);
  const short = new Intl.DateTimeFormat(locale, { timeZone: "UTC", day: "numeric", month: "long" });
  const title = t("agenda.weekOf", {
    from: String(Number(week[0].slice(8))),
    to: short.format(new Date(`${week[6]}T12:00:00Z`)),
  });

  return (
    <View style={styles.gap}>
      <PeriodHeader
        title={title}
        onMove={(direction) => {
          const next = shiftAnchor("week", anchor, direction);
          onAnchor(next);
          setSelected(weekOf(next)[0]);
        }}
      />
      <View style={styles.row}>
        {week.map((day, i) => (
          <View key={day} style={styles.column}>
            <DayCell
              day={day}
              letter={letters[i]}
              selected={day === chosen}
              today={day === today}
              dots={[...new Set((byDay.get(day) ?? []).map((o) => calendarColor(data?.calendars.get(o.calendarId)?.color, c)))]}
              onPress={() => setSelected(day)}
            />
          </View>
        ))}
      </View>
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
  gap: { gap: 12 },
  row: { flexDirection: "row", gap: 4 },
  column: { flex: 1, alignItems: "center", gap: 4 },
});
