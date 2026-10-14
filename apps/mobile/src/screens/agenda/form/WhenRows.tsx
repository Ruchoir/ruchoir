import { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { ArrowRight, CalendarDays, ChevronDown, Clock, Sun } from "lucide-react-native";
import { Platform, Pressable, StyleSheet, Switch, View } from "react-native";

import { useTranslation } from "../../../i18n";
import { useLocale } from "../../../i18n/useLocale";
import { setWhen, type EventDraft, type WhenField } from "../../../logic/eventForm";
import type { RootParams } from "../../../navigation/types";
import { hairline, radius } from "../../../theme/tokens";
import { useTheme } from "../../../theme/useTheme";
import { Text } from "../../../ui/Text";
import { updateDraft } from "./draftStore";
import { FormRow } from "./FormRow";
import { clockLabel, fromPicked, longDay, uses24h, whenDate } from "./when";

/**
 * When the event happens (mockup 19): its day (a start and an end day for a whole day, or an event
 * ending another day), its start and end times, and the whole-day switch. Each value opens the
 * phone's own picker: in a sheet on iOS, as the system's dialog on Android.
 */
export function WhenRows({ formKey, draft, error }: { formKey: string; draft: EventDraft; error?: string }) {
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const { locale } = useLocale();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const pick = (field: WhenField) => {
    if (Platform.OS === "ios") {
      navigation.navigate("eventPicker", { formKey, field });
      return;
    }
    DateTimePickerAndroid.open({
      value: whenDate(draft, field),
      mode: field.endsWith("Day") ? "date" : "time",
      is24Hour: uses24h(locale),
      minimumDate: field === "endDay" ? whenDate(draft, "startDay") : undefined,
      onChange: (event, date) => {
        if (event.type === "set" && date) updateDraft(formKey, (d) => setWhen(d, field, fromPicked(date, field)));
      },
    });
  };
  const severalDays = draft.allDay || draft.endDay !== draft.startDay;
  const dateLine = (field: "startDay" | "endDay", label?: string) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label ?? t("eventForm.pickDate")} ${longDay(draft[field], locale)}`}
      onPress={() => pick(field)}
      style={({ pressed }) => [styles.dateLine, pressed && { opacity: 0.6 }]}
    >
      {label ? (
        <Text variant="small" tone="muted" style={styles.dateLabel}>
          {label}
        </Text>
      ) : null}
      <Text variant="body" style={styles.flex} numberOfLines={1}>
        {longDay(draft[field], locale)}
      </Text>
      <ChevronDown size={18} color={c.muted} />
    </Pressable>
  );
  const timeBox = (field: "startTime" | "endTime", label: string) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label} ${clockLabel(draft[field], locale)}`}
      onPress={() => pick(field)}
      style={({ pressed }) => [styles.box, { borderColor: c.controlLine, backgroundColor: c.surface }, pressed && { opacity: 0.6 }]}
    >
      <Text variant="tiny" tone="muted">
        {label}
      </Text>
      <Text variant="label" style={styles.clock}>
        {clockLabel(draft[field], locale)}
      </Text>
    </Pressable>
  );
  return (
    <>
      <FormRow icon={CalendarDays} tint={c.sky} align={severalDays ? "start" : "center"}>
        {severalDays ? (
          <>
            {dateLine("startDay", t("eventForm.from"))}
            {dateLine("endDay", t("eventForm.to"))}
          </>
        ) : (
          dateLine("startDay")
        )}
      </FormRow>
      {!draft.allDay ? (
        <FormRow icon={Clock} tint={c.violet}>
          <View style={styles.times}>
            {timeBox("startTime", t("eventForm.start"))}
            <ArrowRight size={16} color={c.muted} />
            {timeBox("endTime", t("eventForm.end"))}
          </View>
          {error ? (
            <Text variant="small" tone="danger">
              {error}
            </Text>
          ) : null}
        </FormRow>
      ) : null}
      <FormRow icon={Sun} tint={c.sun}>
        <View style={styles.switchLine}>
          <Text variant="body" style={styles.flex}>
            {t("calendar.allDayEvent")}
          </Text>
          <Switch
            value={draft.allDay}
            onValueChange={(allDay) => updateDraft(formKey, (d) => ({ ...d, allDay }))}
            trackColor={{ true: c.ink, false: s.sunken }}
            accessibilityLabel={t("calendar.allDayEvent")}
          />
        </View>
        {draft.allDay && error ? (
          <Text variant="small" tone="danger">
            {error}
          </Text>
        ) : null}
      </FormRow>
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  dateLine: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 32 },
  dateLabel: { minWidth: 28 },
  times: { flexDirection: "row", alignItems: "center", gap: 8 },
  box: { flex: 1, borderWidth: hairline, borderRadius: radius.m, paddingHorizontal: 12, paddingVertical: 6 },
  clock: { fontSize: 17, lineHeight: 22 },
  switchLine: { flexDirection: "row", alignItems: "center", gap: 12 },
});
