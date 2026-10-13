import { listChannelEvents } from "@ruchoir/client";
import { useNavigation } from "@react-navigation/native";
import { CalendarDays } from "lucide-react-native";
import { FlatList, StyleSheet, View } from "react-native";

import { useLoad } from "../../data/useLoad";
import { useReloadOn } from "../../data/useReloadOn";
import { useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { timeOf } from "../../logic/format";
import { useTheme } from "../../theme/useTheme";
import { EmptyState, LoadState } from "../../ui/States";
import { Text } from "../../ui/Text";
import { EventCardRow } from "../agenda/EventCardRow";

/** The channel's coming events (the Agenda tab of mockup 13). */
export function ConversationAgenda({ channelId }: { channelId: string }) {
  const { t } = useTranslation();
  const { c } = useTheme();
  const { locale, timeZone } = useLocale();
  const navigation = useNavigation();
  const events = useLoad(`channelEvents:${channelId}`, (signal) => listChannelEvents(channelId, signal));
  useReloadOn((e) => e.type === "calendar", events.reload);
  if (!events.data) return <LoadState error={events.error} onRetry={events.reload} />;
  return (
    <FlatList
      data={events.data}
      contentContainerStyle={styles.list}
      keyExtractor={(e) => `${e.eventId}:${e.recurrenceId ?? ""}`}
      ListEmptyComponent={<EmptyState icon={CalendarDays} title={t("conversation.noEvents")} />}
      renderItem={({ item }) => (
        <View style={styles.item}>
          <Text variant="smallStrong">
            {new Intl.DateTimeFormat(locale, { timeZone, weekday: "long", day: "numeric", month: "long" }).format(new Date(item.start))}
          </Text>
          <EventCardRow
            time={item.allDay ? t("agenda.allDay") : timeOf(item.start, locale, timeZone)}
            title={item.title}
            meta={item.location}
            color={c.sky}
            onPress={() => navigation.navigate("eventSummary", { eventId: item.eventId, recurrenceId: item.recurrenceId })}
          />
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  list: { padding: 16, gap: 14, flexGrow: 1 },
  item: { gap: 8 },
});
