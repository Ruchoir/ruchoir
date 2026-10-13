import { listCalendars, listOccurrences, type Calendar, type Occurrence } from "@ruchoir/client";
import { useMemo, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import { useLoad } from "../../data/useLoad";
import { useReloadOn } from "../../data/useReloadOn";
import { key, useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { rangeForView, type AgendaView } from "../../logic/agenda";
import { dayKey } from "../../logic/format";
import { useSpace } from "../../space/SpaceProvider";
import { Segmented } from "../../ui/Segmented";
import { LoadState } from "../../ui/States";
import { NoSpace } from "../../ui/NoSpace";
import { TabHeader } from "../../ui/TabHeader";
import { TabScreen } from "../../ui/TabScreen";
import { ListView } from "./ListView";
import { MonthView } from "./MonthView";
import { WeekView } from "./WeekView";

const VIEWS = [
  { key: "list", label: key("agenda.list") },
  { key: "week", label: key("agenda.week") },
  { key: "month", label: key("agenda.month") },
] as const;

export type AgendaData = { occurrences: Occurrence[]; calendars: Map<string, Calendar> };

/**
 * The agenda (mockups 15 to 17): the person's own calendars and the space's, in a list of what is
 * coming, a week or a month. Read-only in this step: no "New event" button.
 */
export function AgendaScreen() {
  const { t } = useTranslation();
  const { timeZone } = useLocale();
  const { current, status } = useSpace();
  const [view, setView] = useState<AgendaView>("list");
  const today = dayKey(new Date(), timeZone);
  const [anchor, setAnchor] = useState(today);
  const range = rangeForView(view, anchor);

  const data = useLoad(current ? `agenda:${current.id}:${range.from}:${range.to}` : null, async (signal): Promise<AgendaData> => {
    const all = await listCalendars(signal);
    // What a person sees here: their own calendars and the space's, minus the ones they hid.
    const shown = all.filter((cal) => !cal.hidden && (!cal.spaceId || cal.spaceId === current!.id));
    const occurrences = shown.length ? await listOccurrences(range.from, range.to, shown.map((cal) => cal.id), signal) : [];
    return { occurrences, calendars: new Map(shown.map((cal) => [cal.id, cal])) };
  });
  useReloadOn((e) => e.type === "calendar", data.reload);

  const options = useMemo(() => VIEWS.map((v) => ({ key: v.key, label: t(v.label) })), [t]);

  if (status === "none") return <NoSpace title={t("tabs.agenda")} />;

  return (
    <TabScreen>
      <ScrollView contentContainerStyle={styles.page}>
        <TabHeader title={t("tabs.agenda")} />
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
            <WeekView anchor={anchor} today={today} data={data.data} onAnchor={setAnchor} />
          ) : view === "month" ? (
            <MonthView anchor={anchor} today={today} data={data.data} onAnchor={setAnchor} />
          ) : data.data ? (
            <ListView data={data.data} today={today} />
          ) : null}
          {!data.data ? <LoadState error={data.error} onRetry={data.reload} /> : null}
        </View>
      </ScrollView>
    </TabScreen>
  );
}

const styles = StyleSheet.create({
  page: { paddingBottom: 24, gap: 12, flexGrow: 1 },
  body: { paddingHorizontal: 16, gap: 12, flexGrow: 1 },
});
