import { listChannelEvents } from "@ruchoir/client";
import { useNavigation } from "@react-navigation/native";
import { CalendarDays } from "lucide-react-native";
import { ScrollView, StyleSheet, View } from "react-native";

import { useLoad } from "../../data/useLoad";
import { useReloadOn } from "../../data/useReloadOn";
import { useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { groupByDay } from "../../logic/agenda";
import { dayKey, timeOf } from "../../logic/format";
import { useTheme } from "../../theme/useTheme";
import { EmptyState, LoadState } from "../../ui/States";
import { Text } from "../../ui/Text";
import { useDayLabel } from "../agenda/DayEvents";
import { EventCardRow } from "../agenda/EventCardRow";

/**
 * The channel's coming events (the Agenda tab of mockup 13), grouped by day and titled as the
 * agenda's own list is, so the two read the same.
 */
export function ConversationAgenda({ channelId }: { channelId: string }) {
  const { t } = useTranslation();
  const { c } = useTheme();
  const { locale, timeZone } = useLocale();
  const navigation = useNavigation();
  const dayLabel = useDayLabel();
  const events = useLoad(`channelEvents:${channelId}`, (signal) => listChannelEvents(channelId, signal));
  useReloadOn((e) => e.type === "calendar", events.reload);
  if (!events.data) return <LoadState error={events.error} onRetry={events.reload} />;
  if (!events.data.length) {
    return <EmptyState icon={CalendarDays} title={t("conversation.noEvents")} text={t("conversation.noEventsHint")} />;
  }
  const today = dayKey(new Date(), timeZone);
  return (
    <ScrollView contentContainerStyle={styles.list}>
      {groupByDay(events.data, timeZone).map(({ day, items }) => (
        <View key={day} style={styles.day}>
          <Text variant="smallStrong">{dayLabel(day, today)}</Text>
          {items.map((item) => (
            <EventCardRow
              key={`${item.eventId}:${item.recurrenceId ?? ""}`}
              time={item.allDay ? t("agenda.allDay") : timeOf(item.start, locale, timeZone)}
              allDay={item.allDay}
              title={item.title}
              meta={item.location}
              color={c.sky}
              onPress={() => navigation.navigate("eventSummary", { eventId: item.eventId, recurrenceId: item.recurrenceId, start: item.start })}
            />
          ))}
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  list: { padding: 16, gap: 18 },
  day: { gap: 8 },
});
