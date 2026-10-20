import type { Occurrence } from "@ruchoir/client";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { CalendarPlus, ChevronLeft, ChevronRight, Plus } from "lucide-react-native";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import { useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { groupByDay, monthGrid, shiftAnchor, weekOf, type AgendaView } from "../../logic/agenda";
import { timeOf } from "../../logic/format";
import type { RootParams } from "../../navigation/types";
import { usePrefs } from "../../prefs/store";
import { fonts } from "../../theme/fonts";
import { hairline, mix, radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { Button } from "../../ui/Button";
import { LoadState } from "../../ui/States";
import { SpaceSwitch } from "../../ui/TabHeader";
import { TabScreen } from "../../ui/TabScreen";
import { Text } from "../../ui/Text";
import type { AgendaData } from "./AgendaScreen";
import { calendarColor } from "./calendarColor";
import { EventSummary } from "./EventSummarySheet";
import { YearView } from "./YearView";

type Props = {
  view: AgendaView;
  onView: (view: AgendaView) => void;
  anchor: string;
  onAnchor: (day: string) => void;
  today: string;
  data?: AgendaData;
  error: { offline: boolean } | null;
  reload: () => void;
  layout: "landscape" | "portrait";
};

type Opened = { eventId: string; recurrenceId?: string; start: string };

/**
 * The agenda on a tablet (tablet mockups 03 and 04): its head (the title and the space, the three
 * views, "Today" and "New event"), the month, the week or the list on the left, and on the right the
 * chosen day's events or, once one is tapped, its summary.
 */
export function AgendaWide({ view, onView, anchor, onAnchor, today, data, error, reload, layout }: Props) {
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const { locale, timeZone } = useLocale();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const [chosen, setChosen] = useState(today);
  const [opened, setOpened] = useState<Opened | null>(null);
  const byDay = useMemo(() => new Map(groupByDay(data?.occurrences ?? [], timeZone).map((d) => [d.day, d.items])), [data, timeZone]);
  const colorOf = (o: Occurrence) => calendarColor(data?.calendars.get(o.calendarId)?.color, c);
  const pick = (day: string) => {
    setChosen(day);
    setOpened(null);
  };
  const open = (o: Occurrence) => {
    if (o.busy) return;
    setOpened({ eventId: o.eventId, recurrenceId: o.recurrenceId, start: o.start });
  };
  const views: { key: AgendaView; label: string }[] = [
    { key: "list", label: t("agenda.list") },
    { key: "week", label: t("agenda.week") },
    { key: "month", label: t("agenda.month") },
    { key: "year", label: t("agenda.year") },
  ];
  const side = layout === "portrait" ? 280 : 340;

  return (
    <TabScreen>
      <View style={styles.head}>
        <View style={styles.titles}>
          <Text style={[styles.title, { color: c.ink }]}>{t("tabs.agenda")}</Text>
          <SpaceSwitch />
        </View>
        <View accessibilityRole="tablist" style={[styles.views, { backgroundColor: s.sunken, borderColor: c.line }]}>
          {views.map((v) => {
            const on = v.key === view;
            return (
              <Pressable
                key={v.key}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                onPress={() => onView(v.key)}
                style={[styles.view, { borderColor: on ? c.ink : "transparent", backgroundColor: on ? c.acc : "transparent" }]}
              >
                <Text style={[styles.viewText, { color: on ? c.onPastel : c.ink, fontFamily: on ? fonts.sansBold : fonts.sansMedium }]}>{v.label}</Text>
              </Pressable>
            );
          })}
        </View>
        <Button
          variant="secondary"
          size="md"
          label={t("time.today")}
          onPress={() => {
            onAnchor(today);
            pick(today);
          }}
        />
        {data?.canCreate ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => navigation.navigate("eventForm", { day: chosen })}
            style={({ pressed }) => [styles.create, { borderColor: c.acc, backgroundColor: c.surface, shadowColor: c.acc }, pressed && { opacity: 0.7 }]}
          >
            <CalendarPlus size={18} color={c.ink} />
            <Text variant="bodyStrong">{t("calendar.newEvent")}</Text>
          </Pressable>
        ) : null}
      </View>
      <View style={[styles.body, { borderTopColor: c.line }]}>
        <ScrollView style={styles.main} contentContainerStyle={styles.mainContent}>
          {!data ? (
            <LoadState error={error} onRetry={reload} />
          ) : view === "year" ? (
            <YearView
              anchor={anchor}
              today={today}
              data={data}
              columns={layout === "portrait" ? 3 : 4}
              onAnchor={onAnchor}
              onPick={(day) => {
                onView("month");
                onAnchor(day);
                pick(day);
              }}
            />
          ) : view === "month" ? (
            <Month anchor={anchor} today={today} chosen={chosen} byDay={byDay} colorOf={colorOf} onAnchor={onAnchor} onPick={pick} tall={layout === "portrait"} />
          ) : view === "week" ? (
            <Week anchor={anchor} today={today} chosen={chosen} byDay={byDay} colorOf={colorOf} onPick={pick} onOpen={open} onAnchor={onAnchor} />
          ) : (
            <List byDay={byDay} today={today} colorOf={colorOf} onOpen={open} locale={locale} timeZone={timeZone} />
          )}
        </ScrollView>
        <View style={[styles.side, { width: side, borderLeftColor: c.line, backgroundColor: c.surface }]}>
          {opened ? (
            <EventSummary key={`${opened.eventId}:${opened.start}`} {...opened} panel onClose={() => setOpened(null)} />
          ) : (
            <DayPanel
              day={view === "list" ? today : chosen}
              today={today}
              items={byDay.get(view === "list" ? today : chosen) ?? []}
              colorOf={colorOf}
              onOpen={open}
              canCreate={!!data?.canCreate}
            />
          )}
        </View>
      </View>
    </TabScreen>
  );
}

/** A month: its name and arrows, the weekdays, and each day's first two events as chips. */
function Month({
  anchor,
  today,
  chosen,
  byDay,
  colorOf,
  onAnchor,
  onPick,
  tall,
}: {
  anchor: string;
  today: string;
  chosen: string;
  byDay: Map<string, Occurrence[]>;
  colorOf: (o: Occurrence) => string;
  onAnchor: (day: string) => void;
  onPick: (day: string) => void;
  tall: boolean;
}) {
  const { t } = useTranslation();
  const { c } = useTheme();
  const { locale } = useLocale();
  const { weekStart } = usePrefs();
  const month = anchor.slice(0, 7);
  const grid = monthGrid(month, weekStart);
  const name = new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(`${month}-15T12:00:00Z`));
  const weekdays = useWeekdays();
  const move = (direction: 1 | -1) => {
    const next = shiftAnchor("month", anchor, direction);
    onAnchor(next);
    onPick(next);
  };
  return (
    <View>
      <View style={styles.periodHead}>
        <Text style={[styles.periodTitle, { color: c.ink }]}>{name.charAt(0).toLocaleUpperCase(locale) + name.slice(1)}</Text>
        <Arrows onMove={move} />
      </View>
      <View style={styles.weekdays}>
        {weekdays.map((w) => (
          <Text key={w} style={[styles.weekday, { color: c.muted }]}>
            {w}
          </Text>
        ))}
      </View>
      <View style={styles.weeks}>
        {grid.map((week, i) => (
          <View key={i} style={styles.weekRow}>
            {week.map((day, j) => {
              if (!day) return <View key={j} style={[styles.cell, styles.blank, { minHeight: tall ? 110 : 92 }]} />;
              const on = day === chosen;
              const isToday = day === today;
              const items = byDay.get(day) ?? [];
              return (
                <Pressable
                  key={day}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  onPress={() => onPick(day)}
                  style={[
                    styles.cell,
                    { minHeight: tall ? 110 : 92, borderColor: on ? c.ink : isToday ? c.acc : c.line, backgroundColor: on ? mix(c.acc, c.surface, 0.26) : c.surface },
                  ]}
                >
                  <View style={[styles.number, (on || isToday) && { backgroundColor: c.acc }]}>
                    <Text style={[styles.numberText, { color: on || isToday ? c.onPastel : c.ink, fontFamily: on || isToday ? fonts.sansBold : fonts.sansMedium }]}>
                      {Number(day.slice(8))}
                    </Text>
                  </View>
                  {items.slice(0, 2).map((o) => (
                    <View key={`${o.eventId}:${o.start}`} style={[styles.chip, { backgroundColor: mix(colorOf(o), c.surface, 0.3) }]}>
                      <View style={[styles.dot, { backgroundColor: colorOf(o) }]} />
                      <Text style={[styles.chipText, { color: c.ink }]} numberOfLines={1}>
                        {o.title}
                      </Text>
                    </View>
                  ))}
                  {items.length > 2 ? <Text style={[styles.more, { color: c.muted }]}>{t("agenda.more", { count: items.length - 2 })}</Text> : null}
                </Pressable>
              );
            })}
          </View>
        ))}
      </View>
    </View>
  );
}

/** A week: its dates and arrows, each day's head, its events under it. */
function Week({
  anchor,
  today,
  chosen,
  byDay,
  colorOf,
  onPick,
  onOpen,
  onAnchor,
}: {
  anchor: string;
  today: string;
  chosen: string;
  byDay: Map<string, Occurrence[]>;
  colorOf: (o: Occurrence) => string;
  onPick: (day: string) => void;
  onOpen: (o: Occurrence) => void;
  onAnchor: (day: string) => void;
}) {
  const { t } = useTranslation();
  const { c } = useTheme();
  const { locale, timeZone } = useLocale();
  const { weekStart } = usePrefs();
  const days = weekOf(anchor, weekStart);
  const short = new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "short" });
  const dayMonth = new Intl.DateTimeFormat(locale, { timeZone: "UTC", day: "numeric", month: "long" });
  const at = (day: string) => new Date(`${day}T12:00:00Z`);
  const first = days[0];
  const last = days[days.length - 1];
  const from = first.slice(0, 7) === last.slice(0, 7) ? String(Number(first.slice(8))) : dayMonth.format(at(first));
  return (
    <View>
      <View style={styles.periodHead}>
        <Text style={[styles.periodTitle, { color: c.ink }]}>{t("agenda.weekOf", { from, to: dayMonth.format(at(last)) })}</Text>
        <Arrows
          onMove={(direction) => {
            const next = shiftAnchor("week", anchor, direction);
            onAnchor(next);
            onPick(next);
          }}
        />
      </View>
      <View style={styles.weekColumns}>
        {days.map((day) => {
          const on = day === chosen;
          const isToday = day === today;
          const label = short.format(at(day));
          return (
            <View key={day} style={styles.weekColumn}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                onPress={() => onPick(day)}
                style={[
                  styles.weekHead,
                  { borderColor: on ? c.ink : isToday ? c.acc : c.line, backgroundColor: on ? c.acc : isToday ? mix(c.acc, c.bg, 0.22) : c.surface },
                ]}
              >
                <Text style={[styles.weekDayName, { color: on ? c.onPastel : c.ink }]}>{label.charAt(0).toLocaleUpperCase(locale) + label.slice(1)}</Text>
                <Text style={[styles.weekDayNumber, { color: on ? c.onPastel : c.ink }]}>{Number(day.slice(8))}</Text>
              </Pressable>
              {(byDay.get(day) ?? []).map((o) => (
                <Pressable
                  key={`${o.eventId}:${o.start}`}
                  accessibilityRole="button"
                  onPress={() => onOpen(o)}
                  style={[styles.block, { backgroundColor: mix(colorOf(o), c.surface, 0.28), borderColor: mix(colorOf(o), c.surface, 0.7) }]}
                >
                  <Text style={[styles.blockTime, { color: c.ink }]}>{o.allDay ? t("agenda.allDay") : timeOf(o.start, locale, timeZone)}</Text>
                  <Text style={[styles.blockTitle, { color: c.ink }]} numberOfLines={3}>
                    {o.title}
                  </Text>
                </Pressable>
              ))}
            </View>
          );
        })}
      </View>
    </View>
  );
}

/** What is coming: each day with events, its events with their hours and place. */
function List({
  byDay,
  today,
  colorOf,
  onOpen,
  locale,
  timeZone,
}: {
  byDay: Map<string, Occurrence[]>;
  today: string;
  colorOf: (o: Occurrence) => string;
  onOpen: (o: Occurrence) => void;
  locale: string;
  timeZone: string;
}) {
  const { t } = useTranslation();
  const { c } = useTheme();
  const label = useDayTitle();
  const days = [...byDay.entries()].filter(([day]) => day >= today).sort(([a], [b]) => a.localeCompare(b));
  if (!days.length) return <Text tone="muted">{t("agenda.nothingSoonHint")}</Text>;
  return (
    <View>
      {days.map(([day, items]) => (
        <View key={day}>
          <Text style={[styles.listDay, { color: c.ink }]}>{label(day, today)}</Text>
          <View style={styles.listItems}>
            {items.map((o) => (
              <Pressable
                key={`${o.eventId}:${o.start}`}
                accessibilityRole="button"
                onPress={() => onOpen(o)}
                style={[styles.listRow, { backgroundColor: mix(colorOf(o), c.surface, 0.24), borderColor: mix(colorOf(o), c.surface, 0.7) }]}
              >
                <View style={[styles.bar, { backgroundColor: colorOf(o) }]} />
                <Text style={[styles.listTime, { color: c.ink }]}>
                  {o.allDay ? t("agenda.allDay") : `${timeOf(o.start, locale, timeZone)} – ${timeOf(o.end, locale, timeZone)}`}
                </Text>
                <View style={styles.listText}>
                  <Text style={[styles.listTitle, { color: c.ink }]}>{o.title}</Text>
                  {o.location ? <Text style={[styles.listWhere, { color: c.muted }]}>{o.location}</Text> : null}
                </View>
              </Pressable>
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

/** The chosen day beside the calendar: its events, or that it is free, and adding one on it. */
function DayPanel({
  day,
  today,
  items,
  colorOf,
  onOpen,
  canCreate,
}: {
  day: string;
  today: string;
  items: Occurrence[];
  colorOf: (o: Occurrence) => string;
  onOpen: (o: Occurrence) => void;
  canCreate: boolean;
}) {
  const { t } = useTranslation();
  const { c } = useTheme();
  const { locale, timeZone } = useLocale();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const label = useDayTitle();
  return (
    <ScrollView contentContainerStyle={styles.panel}>
      <Text style={[styles.panelTitle, { color: c.ink }]}>{label(day, today)}</Text>
      <View style={styles.panelItems}>
        {items.map((o) => (
          <Pressable
            key={`${o.eventId}:${o.start}`}
            accessibilityRole="button"
            onPress={() => onOpen(o)}
            style={[styles.panelRow, { backgroundColor: mix(colorOf(o), c.surface, 0.24), borderColor: mix(colorOf(o), c.surface, 0.7) }]}
          >
            <View style={[styles.bar, { backgroundColor: colorOf(o) }]} />
            <View style={styles.listText}>
              <Text style={[styles.panelTime, { color: c.ink }]}>
                {o.allDay ? t("agenda.allDay") : `${timeOf(o.start, locale, timeZone)} – ${timeOf(o.end, locale, timeZone)}`}
              </Text>
              <Text style={[styles.listTitle, { color: c.ink }]}>{o.title}</Text>
              {o.location ? <Text style={[styles.panelWhere, { color: c.muted }]}>{o.location}</Text> : null}
            </View>
          </Pressable>
        ))}
        {items.length === 0 ? (
          <View style={[styles.free, { borderColor: c.lineStrong }]}>
            <Text style={[styles.freeText, { color: c.muted }]}>{t("agenda.nothingThatDay")}</Text>
          </View>
        ) : null}
        {canCreate ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => navigation.navigate("eventForm", { day })}
            style={({ pressed }) => [styles.ghost, pressed && { backgroundColor: c.line }]}
          >
            <Plus size={18} color={c.ink} />
            <Text variant="smallStrong">{t("agenda.addThatDay")}</Text>
          </Pressable>
        ) : null}
      </View>
    </ScrollView>
  );
}

/** The previous and next period, as two square buttons. */
function Arrows({ onMove }: { onMove: (direction: 1 | -1) => void }) {
  const { t } = useTranslation();
  const { c } = useTheme();
  return (
    <View style={styles.arrows}>
      <Pressable accessibilityRole="button" accessibilityLabel={t("agenda.previous")} onPress={() => onMove(-1)} style={[styles.arrow, { borderColor: c.lineStrong }]}>
        <ChevronLeft size={20} color={c.body} />
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={t("agenda.next")} onPress={() => onMove(1)} style={[styles.arrow, { borderColor: c.lineStrong }]}>
        <ChevronRight size={20} color={c.body} />
      </Pressable>
    </View>
  );
}

/** "Lun.", "Mar."... in the order the person's week starts. */
function useWeekdays(): string[] {
  const { locale } = useLocale();
  const { weekStart } = usePrefs();
  const format = new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "short" });
  // 2024-01-01 was a Monday.
  return weekOf("2024-01-01", weekStart).map((day) => {
    const name = format.format(new Date(`${day}T12:00:00Z`));
    return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
  });
}

/** "Aujourd'hui · mardi 16 juin", or the date alone for another day. */
function useDayTitle(): (day: string, today: string) => string {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const format = new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" });
  return (day, today) => {
    const text = format.format(new Date(`${day}T12:00:00Z`));
    const named = text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);
    return day === today ? t("agenda.todayLabel", { day: named }) : named;
  };
}

// The tablet mockups' agenda measures.
const styles = StyleSheet.create({
  head: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 14, paddingTop: 24, paddingHorizontal: 28, paddingBottom: 16 },
  titles: { flex: 1, minWidth: 180, gap: 2 },
  title: { fontSize: 32, lineHeight: 38, fontFamily: fonts.sansBold, letterSpacing: -1.1 },
  views: { flexDirection: "row", width: 300, padding: 3, borderRadius: radius.m, borderWidth: hairline },
  view: { flex: 1, height: 38, borderRadius: 7, borderWidth: hairline, alignItems: "center", justifyContent: "center" },
  viewText: { fontSize: 14, lineHeight: 19 },
  create: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    height: 44,
    paddingHorizontal: 16,
    borderRadius: radius.m,
    borderWidth: 2,
    shadowOffset: { width: 3, height: 3 },
    shadowOpacity: 1,
    shadowRadius: 0,
    elevation: 3,
  },
  body: { flex: 1, flexDirection: "row", borderTopWidth: hairline },
  main: { flex: 1, minWidth: 0 },
  mainContent: { paddingTop: 18, paddingHorizontal: 24, paddingBottom: 28 },
  side: { borderLeftWidth: hairline },
  periodHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingBottom: 10 },
  periodTitle: { fontSize: 22, lineHeight: 28, fontFamily: fonts.sansBold },
  arrows: { flexDirection: "row", gap: 4 },
  arrow: { width: 44, height: 44, borderRadius: radius.m, borderWidth: hairline, alignItems: "center", justifyContent: "center" },
  weekdays: { flexDirection: "row", gap: 6, paddingBottom: 6 },
  weekday: { flex: 1, paddingLeft: 8, fontSize: 13, lineHeight: 17, fontFamily: fonts.sansSemibold },
  weeks: { gap: 6 },
  weekRow: { flexDirection: "row", gap: 6 },
  cell: { flex: 1, minWidth: 0, gap: 4, padding: 6, borderRadius: radius.m, borderWidth: hairline },
  blank: { borderColor: "transparent" },
  number: { alignSelf: "flex-start", minWidth: 26, height: 26, paddingHorizontal: 4, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  numberText: { fontSize: 14, lineHeight: 19 },
  chip: { flexDirection: "row", alignItems: "center", gap: 5, paddingVertical: 2, paddingHorizontal: 6, borderRadius: 3, minWidth: 0 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  chipText: { flexShrink: 1, fontSize: 11.5, lineHeight: 15, fontFamily: fonts.sans },
  more: { fontSize: 11, lineHeight: 14, paddingLeft: 6 },
  weekColumns: { flexDirection: "row", gap: 8, alignItems: "flex-start" },
  weekColumn: { flex: 1, minWidth: 0, gap: 6 },
  weekHead: { height: 60, borderRadius: radius.m, borderWidth: hairline, alignItems: "center", justifyContent: "center", gap: 2 },
  weekDayName: { fontSize: 13, lineHeight: 17, fontFamily: fonts.sansMedium },
  weekDayNumber: { fontSize: 22, lineHeight: 26, fontFamily: fonts.sansBold },
  block: { gap: 2, padding: 8, borderRadius: radius.s, borderWidth: hairline },
  blockTime: { fontSize: 11, lineHeight: 14, fontFamily: fonts.monoSemibold },
  blockTitle: { fontSize: 13, lineHeight: 17, fontFamily: fonts.sansSemibold },
  listDay: { paddingVertical: 8, fontSize: 15, lineHeight: 20, fontFamily: fonts.sansBold },
  listItems: { gap: 8, paddingBottom: 12 },
  listRow: { flexDirection: "row", gap: 14, paddingVertical: 14, paddingHorizontal: 16, borderRadius: radius.m, borderWidth: hairline },
  bar: { width: 4, borderRadius: 2 },
  listTime: { width: 110, fontSize: 14, lineHeight: 20, fontFamily: fonts.monoSemibold, paddingTop: 1 },
  listText: { flex: 1, minWidth: 0, gap: 3 },
  listTitle: { fontSize: 16, lineHeight: 21, fontFamily: fonts.sansSemibold },
  listWhere: { fontSize: 14, lineHeight: 19 },
  panel: { paddingVertical: 22, paddingHorizontal: 20 },
  panelTitle: { fontSize: 17, lineHeight: 22, fontFamily: fonts.sansBold, paddingBottom: 12 },
  panelItems: { gap: 8 },
  panelRow: { flexDirection: "row", gap: 12, paddingVertical: 12, paddingHorizontal: 14, borderRadius: radius.m, borderWidth: hairline },
  panelTime: { fontSize: 13, lineHeight: 17, fontFamily: fonts.monoSemibold },
  panelWhere: { fontSize: 13, lineHeight: 17 },
  free: { paddingVertical: 22, paddingHorizontal: 14, borderRadius: radius.m, borderWidth: hairline, borderStyle: "dashed", alignItems: "center" },
  freeText: { fontSize: 14, lineHeight: 19, textAlign: "center" },
  ghost: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 40, paddingHorizontal: 8, borderRadius: radius.m, alignSelf: "flex-start" },
});
