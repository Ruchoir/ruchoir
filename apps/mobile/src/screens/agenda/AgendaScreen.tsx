import { listCalendars, listOccurrences, type Calendar, type Occurrence } from "@ruchoir/client";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { CalendarPlus } from "lucide-react-native";
import { useMemo, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import { useLoad } from "../../data/useLoad";
import { useReloadOn } from "../../data/useReloadOn";
import { key, useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { rangeForView, type AgendaView } from "../../logic/agenda";
import { dayKey } from "../../logic/format";
import type { RootParams } from "../../navigation/types";
import { useSpace } from "../../space/SpaceProvider";
import { FloatingButton, useFloatingScroll } from "../../ui/FloatingButton";
import { Segmented } from "../../ui/Segmented";
import { LoadState } from "../../ui/States";
import { TabHeader } from "../../ui/TabHeader";
import { TabScreen } from "../../ui/TabScreen";
import { ListView } from "./ListView";
import { MonthView } from "./MonthView";
import { WeekView } from "./WeekView";
import { usePrefs } from "../../prefs/store";

const VIEWS = [
  { key: "list", label: key("agenda.list") },
  { key: "week", label: key("agenda.week") },
  { key: "month", label: key("agenda.month") },
] as const;

export type AgendaData = {
  occurrences: Occurrence[];
  calendars: Map<string, Calendar>;
  /** Whether the person may write in any calendar: "New event" shows then. */
  canCreate: boolean;
};

/**
 * The agenda (mockups 15 to 17): the person's own calendars and the space's, in a list of what is
 * coming, a week or a month. "New event" starts on the day looked at: today in the list, the day
 * chosen in a week or a month.
 */
export function AgendaScreen() {
  const { t } = useTranslation();
  const { timeZone } = useLocale();
  const { current } = useSpace();
  const prefs = usePrefs();
  const [view, setView] = useState<AgendaView>(prefs.agendaView);
  const today = dayKey(new Date(), timeZone);
  const [anchor, setAnchor] = useState(today);
  const range = rangeForView(view, anchor, prefs.weekStart);
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const floating = useFloatingScroll();
  // The day chosen in the week or the month (they say it); the list starts new events today.
  const [chosen, setChosen] = useState(today);

  const data = useLoad(current ? `agenda:${current.id}:${range.from}:${range.to}` : null, async (signal): Promise<AgendaData> => {
    const all = await listCalendars(signal);
    // What a person sees here: their own calendars and the space's, minus the ones they hid.
    const shown = all.filter((cal) => !cal.hidden && (!cal.spaceId || cal.spaceId === current!.id));
    const occurrences = shown.length ? await listOccurrences(range.from, range.to, shown.map((cal) => cal.id), signal) : [];
    return { occurrences, calendars: new Map(shown.map((cal) => [cal.id, cal])), canCreate: all.some((cal) => cal.canWriteEvents) };
  }, { keep: current?.id });
  useReloadOn((e) => e.type === "calendar", data.reload);

  const options = useMemo(() => VIEWS.map((v) => ({ key: v.key, label: t(v.label) })), [t]);


  return (
    <TabScreen>
      <TabHeader title={t("tabs.agenda")} />
      <ScrollView contentContainerStyle={styles.page} onScroll={floating.onScroll} scrollEventThrottle={floating.scrollEventThrottle}>
        <Segmented
          options={options}
          value={view}
          onChange={(next) => {
            setView(next);
            setAnchor(today);
          }}
        />
        <View style={styles.body}>
          {view === "week" ? (
            <WeekView anchor={anchor} today={today} data={data.data} onAnchor={setAnchor} onChosen={setChosen} />
          ) : view === "month" ? (
            <MonthView anchor={anchor} today={today} data={data.data} onAnchor={setAnchor} onChosen={setChosen} />
          ) : data.data ? (
            <ListView data={data.data} today={today} />
          ) : null}
          {!data.data ? <LoadState error={data.error} onRetry={data.reload} /> : null}
        </View>
      </ScrollView>
      {data.data?.canCreate ? (
        <FloatingButton
          compact={floating.compact}
          icon={CalendarPlus}
          label={t("calendar.newEvent")}
          onPress={() => navigation.navigate("eventForm", { day: view === "list" ? today : chosen })}
        />
      ) : null}
    </TabScreen>
  );
}

const styles = StyleSheet.create({
  // Room under the last event for the floating button.
  // The tab's head stays above the page (it does not scroll away); the gap it had below it, here.
  page: { paddingTop: 12, paddingBottom: 96, gap: 12, flexGrow: 1 },
  body: { paddingHorizontal: 16, gap: 12, flexGrow: 1 },
});
