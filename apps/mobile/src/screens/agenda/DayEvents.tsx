import type { Occurrence } from "@ruchoir/client";
import { useNavigation } from "@react-navigation/native";
import { StyleSheet, View } from "react-native";

import { useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { timeOf } from "../../logic/format";
import { useTheme } from "../../theme/useTheme";
import { Text } from "../../ui/Text";
import type { AgendaData } from "./AgendaScreen";
import { calendarColor } from "./calendarColor";
import { EventCardRow } from "./EventCardRow";

/** "Today · Tuesday 16 June", or the day's own name. */
export function useDayLabel() {
  const { t } = useTranslation();
  const { locale } = useLocale();
  return (day: string, today: string) => {
    const long = new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(
      new Date(`${day}T12:00:00Z`),
    );
    const named = long.charAt(0).toLocaleUpperCase(locale) + long.slice(1);
    return day === today ? t("agenda.todayLabel", { day: named }) : named;
  };
}

/** One day's heading and its events as cards. */
export function DayEvents({ day, today, items, data }: { day: string; today: string; items: Occurrence[]; data: AgendaData }) {
  const { t } = useTranslation();
  const { c } = useTheme();
  const { locale, timeZone } = useLocale();
  const navigation = useNavigation();
  const label = useDayLabel();
  return (
    <View style={styles.day}>
      <Text variant="smallStrong">{label(day, today)}</Text>
      {items.map((o) => (
        <EventCardRow
          key={`${o.eventId}:${o.recurrenceId ?? ""}:${day}`}
          time={o.allDay ? t("agenda.allDay") : timeOf(o.start, locale, timeZone)}
          title={o.title}
          meta={o.location}
          color={calendarColor(data.calendars.get(o.calendarId)?.color, c)}
          onPress={() => navigation.navigate("eventSummary", { eventId: o.eventId, recurrenceId: o.recurrenceId })}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  day: { gap: 8 },
});
