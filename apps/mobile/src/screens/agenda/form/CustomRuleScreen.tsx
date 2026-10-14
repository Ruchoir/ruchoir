import { WEEKDAYS, rulePhrase, weekdayCode, withStartDay, type Frequency, type MonthlyMode, type RuleForm, type Weekday } from "@ruchoir/client/calendarLogic";
import { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { CalendarCheck, CalendarDays, Check, ChevronDown, Infinity as Endless, Hash } from "lucide-react-native";
import type { ReactNode } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { key, useTranslation } from "../../../i18n";
import { useSharedT } from "../../../i18n/sharedT";
import { useLocale } from "../../../i18n/useLocale";
import type { RootParams } from "../../../navigation/types";
import { hairline, radius } from "../../../theme/tokens";
import { useTheme } from "../../../theme/useTheme";
import { ActionRow } from "../../../ui/ActionRow";
import { Button } from "../../../ui/Button";
import { Chips } from "../../../ui/Chips";
import { Segmented } from "../../../ui/Segmented";
import { SheetHeader } from "../../../ui/SheetHeader";
import { Text } from "../../../ui/Text";
import { updateDraft, useDraft } from "./draftStore";
import { Stepper } from "./Stepper";
import { fromPicked, longDay } from "./when";

const UNITS = [
  { key: "DAILY", label: key("calendar.unitDay") },
  { key: "WEEKLY", label: key("calendar.unitWeek") },
  { key: "MONTHLY", label: key("calendar.unitMonth") },
  { key: "YEARLY", label: key("calendar.unitYear") },
] as const;

const DAY_KEYS = {
  MO: key("calendar.rule.mo"),
  TU: key("calendar.rule.tu"),
  WE: key("calendar.rule.we"),
  TH: key("calendar.rule.th"),
  FR: key("calendar.rule.fr"),
  SA: key("calendar.rule.sa"),
  SU: key("calendar.rule.su"),
} as const;

const NTH_KEYS = [
  { nth: 1, label: key("calendar.rule.nth1") },
  { nth: 2, label: key("calendar.rule.nth2") },
  { nth: 3, label: key("calendar.rule.nth3") },
  { nth: 4, label: key("calendar.rule.nth4") },
  { nth: -1, label: key("calendar.rule.nthLast") },
] as const;

/**
 * The custom repetition (the web's `RecurrenceEditor`): every N days, weeks, months or years; the
 * days of a week; for a month, the start's date, "the 2nd Thursday" or the last working day; and
 * when it stops. The rule is said back in words on top as it is built.
 */
export function CustomRuleScreen() {
  const { params } = useRoute<RouteProp<RootParams, "eventRule">>();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const { t } = useTranslation();
  const say = useSharedT();
  const { c, s } = useTheme();
  const { locale } = useLocale();
  const insets = useSafeAreaInsets();
  const draft = useDraft(params.formKey);
  if (!draft) return null;
  const form = draft.custom;
  const start = draft.startDay;
  const set = (patch: Partial<RuleForm>) => updateDraft(params.formKey, (d) => ({ ...d, custom: { ...d.custom, ...patch }, preset: "custom", ruleTouched: true }));
  // The series starts on this day, so the rule always holds it (see `buildRule`).
  const firstDay = weekdayCode(start);
  const toggleDay = (day: Weekday) => {
    if (day === firstDay) return;
    const days = form.days.includes(day) ? form.days.filter((d) => d !== day) : [...form.days, day];
    if (days.length > 0) set({ days: WEEKDAYS.filter((d) => days.includes(d)) });
  };
  const initials = WEEKDAYS.map((_, i) =>
    new Intl.DateTimeFormat(locale, { weekday: "narrow", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 9, 19 + i, 12))),
  );
  const weekly = form.freq === "WEEKLY";
  const byMonth = form.freq === "MONTHLY";
  const monthly = form.monthly;
  const nthDay: Extract<MonthlyMode, { mode: "nth" }> = monthly.mode === "nth" ? monthly : { mode: "nth", nth: 1, day: form.days[0] ?? firstDay };
  const until = form.end.kind === "until" ? form.end.date : start;
  const pickUntil = () => {
    if (Platform.OS === "ios") {
      navigation.navigate("eventPicker", { formKey: params.formKey, field: "until" });
      return;
    }
    const [y, m, d] = until.split("-").map(Number);
    const [sy, sm, sd] = start.split("-").map(Number);
    DateTimePickerAndroid.open({
      value: new Date(y, m - 1, d, 12),
      mode: "date",
      minimumDate: new Date(sy, sm - 1, sd, 12),
      onChange: (event, date) => {
        if (event.type === "set" && date) set({ end: { kind: "until", date: fromPicked(date, "startDay") } });
      },
    });
  };
  const tick = (on: boolean) => (on ? <Check size={20} color={c.ink} /> : undefined);
  const group = (title: string, children: ReactNode) => (
    <View style={styles.group}>
      <Text variant="smallStrong" tone="muted" style={styles.gutter}>
        {title}
      </Text>
      {children}
    </View>
  );

  return (
    <View style={[styles.fill, { backgroundColor: c.surface }]}>
      <SheetHeader title={t("calendar.customRule")} onClose={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}>
        <View style={[styles.phrase, { backgroundColor: s.sunken }]} accessibilityLiveRegion="polite">
          <Text variant="bodyStrong">{rulePhrase(withStartDay(form, start), start, locale, say)}</Text>
        </View>

        {group(
          t("calendar.repeatEvery"),
          <>
            <View style={styles.gutter}>
              <Stepper value={form.interval} min={1} max={99} onChange={(interval) => set({ interval })} label={t("calendar.repeatEvery")} />
            </View>
            <Segmented<Frequency>
              options={UNITS.map((u) => ({ key: u.key, label: t(u.label, { count: form.interval }) }))}
              value={form.freq}
              onChange={(freq) => set({ freq })}
            />
          </>,
        )}

        {weekly
          ? group(
              t("calendar.onDays"),
              <>
                <View style={[styles.gutter, styles.days]}>
                  {WEEKDAYS.map((day, i) => {
                    const fixed = day === firstDay;
                    const on = fixed || form.days.includes(day);
                    return (
                      <Pressable
                        key={day}
                        accessibilityRole="checkbox"
                        accessibilityLabel={t(DAY_KEYS[day])}
                        accessibilityState={{ checked: on, disabled: fixed }}
                        onPress={() => toggleDay(day)}
                        style={[styles.day, { borderColor: on ? c.ink : c.controlLine, backgroundColor: on ? c.acc : c.surface }]}
                      >
                        <Text variant="smallStrong" style={{ color: on ? c.onPastel : c.ink }}>
                          {initials[i]}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
                <Text variant="tiny" tone="muted" style={styles.gutter}>
                  {t("calendar.startDayKept")}
                </Text>
              </>,
            )
          : null}

        {byMonth ? (
          <View style={styles.group}>
            <View style={styles.gutter}>
              <ActionRow
                icon={CalendarDays}
                tint={c.sky}
                title={t("calendar.monthlyOnDay", { day: Number(start.slice(8)) })}
                selected={monthly.mode === "day"}
                trailing={tick(monthly.mode === "day")}
                onPress={() => set({ monthly: { mode: "day" } })}
              />
              <ActionRow
                icon={CalendarDays}
                tint={c.sky}
                title={t("calendar.monthlyOnWeekday")}
                selected={monthly.mode === "nth"}
                trailing={tick(monthly.mode === "nth")}
                onPress={() => set({ monthly: nthDay })}
              />
            </View>
            {monthly.mode === "nth" ? (
              <View style={styles.nth}>
                <Chips
                  chips={NTH_KEYS.map((n) => ({ key: String(n.nth), label: t(n.label) }))}
                  value={String(nthDay.nth)}
                  onChange={(nth) => set({ monthly: { ...nthDay, nth: Number(nth) as 1 | 2 | 3 | 4 | -1 } })}
                />
                <Chips
                  chips={WEEKDAYS.map((d) => ({ key: d, label: t(DAY_KEYS[d]) }))}
                  value={nthDay.day}
                  onChange={(day) => set({ monthly: { ...nthDay, day: day as Weekday } })}
                />
              </View>
            ) : null}
            <View style={styles.gutter}>
              <ActionRow
                icon={CalendarDays}
                tint={c.sky}
                title={say("calendar.rule.lastWorkday", { count: 1 })}
                selected={monthly.mode === "lastWorkday"}
                trailing={tick(monthly.mode === "lastWorkday")}
                onPress={() => set({ monthly: { mode: "lastWorkday" } })}
              />
            </View>
          </View>
        ) : null}

        <View style={[styles.group, styles.gutter]}>
          <Text variant="smallStrong" tone="muted">
            {t("calendar.ends")}
          </Text>
          <ActionRow
            icon={Endless}
            tint={c.mint}
            title={t("calendar.endNever")}
            selected={form.end.kind === "never"}
            trailing={tick(form.end.kind === "never")}
            onPress={() => set({ end: { kind: "never" } })}
          />
          <ActionRow
            icon={Hash}
            tint={c.mint}
            title={t("calendar.endAfter")}
            subtitle={form.end.kind === "count" ? `${form.end.count} ${t("calendar.times")}` : undefined}
            selected={form.end.kind === "count"}
            trailing={tick(form.end.kind === "count")}
            onPress={() => set({ end: { kind: "count", count: form.end.kind === "count" ? form.end.count : 10 } })}
          />
          {form.end.kind === "count" ? (
            <View style={styles.inline}>
              <Stepper
                value={form.end.count}
                min={1}
                max={999}
                onChange={(count) => set({ end: { kind: "count", count } })}
                label={t("calendar.endAfter")}
              />
              <Text variant="body">{t("calendar.times")}</Text>
            </View>
          ) : null}
          <ActionRow
            icon={CalendarCheck}
            tint={c.mint}
            title={t("calendar.endUntil")}
            selected={form.end.kind === "until"}
            trailing={tick(form.end.kind === "until")}
            onPress={() => set({ end: { kind: "until", date: until } })}
          />
          {form.end.kind === "until" ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${t("calendar.endUntil")} ${longDay(until, locale)}`}
              onPress={pickUntil}
              style={({ pressed }) => [styles.untilLine, { borderColor: c.controlLine }, pressed && { opacity: 0.6 }]}
            >
              <Text variant="body" style={styles.grow}>
                {longDay(until, locale)}
              </Text>
              <ChevronDown size={18} color={c.muted} />
            </Pressable>
          ) : null}
        </View>

        <View style={styles.gutter}>
          <Button label={t("group.pickDone")} onPress={() => navigation.goBack()} />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  grow: { flex: 1 },
  content: { gap: 18 },
  gutter: { paddingHorizontal: 16 },
  phrase: { marginHorizontal: 16, padding: 12, borderRadius: radius.m },
  group: { gap: 8 },
  days: { flexDirection: "row", justifyContent: "space-between" },
  day: { width: 40, height: 40, borderRadius: 20, borderWidth: hairline, alignItems: "center", justifyContent: "center" },
  nth: { gap: 8 },
  inline: { flexDirection: "row", alignItems: "center", gap: 10, paddingLeft: 52 },
  untilLine: { flexDirection: "row", alignItems: "center", gap: 8, marginLeft: 52, paddingHorizontal: 12, paddingVertical: 10, borderWidth: hairline, borderRadius: radius.m },
});
