import { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { CalendarDays, Clock, Sun } from "lucide-react-native";
import { useState } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";

import { useTranslation } from "../../../i18n";
import { useLocale } from "../../../i18n/useLocale";
import { setWhen, type EventDraft, type WhenField } from "../../../logic/eventForm";
import type { RootParams } from "../../../navigation/types";
import { hairline, radius } from "../../../theme/tokens";
import { useTheme } from "../../../theme/useTheme";
import { Text } from "../../../ui/Text";
import { updateDraft } from "./draftStore";
import { FormRow } from "./FormRow";
import { clockLabel, fromPicked, longDay, mediumDay, uses24h, whenDate } from "./when";
import { Toggle } from "../../../ui/Toggle";

/**
 * When the event happens (mockup 19, as the phone's calendar lays it out): its start and its end, each
 * a day and (a timed event) a time, so an event may end another day; and the whole-day switch. Each
 * value opens the phone's own picker: in a sheet on iOS, as the system's dialog on Android.
 */
export function WhenRows({ formKey, draft, error }: { formKey: string; draft: EventDraft; error?: string }) {
  const { t } = useTranslation();
  const { c } = useTheme();
  const { locale } = useLocale();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const [labelWidth, setLabelWidth] = useState(0);
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
  /** One end of the event: its label, its day, and (a timed event) its time, as the phone's calendar shows them. */
  const end = (which: "start" | "end") => {
    const dayField = which === "start" ? "startDay" : "endDay";
    const timeField = which === "start" ? "startTime" : "endTime";
    const label = which === "start" ? t("eventForm.start") : t("eventForm.end");
    return (
      <View style={styles.line}>
        {/* As wide as the longer of the two words in the reader's language ("Początek"), so both
            rows line up and neither word is cut. */}
        <Text
          variant="smallStrong"
          tone="muted"
          numberOfLines={1}
          style={[styles.label, { minWidth: labelWidth }]}
          onLayout={(e) => {
            const width = Math.ceil(e.nativeEvent.layout.width);
            setLabelWidth((now) => (width > now ? width : now));
          }}
        >
          {label}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${label} ${longDay(draft[dayField], locale)}`}
          onPress={() => pick(dayField)}
          style={({ pressed }) => [styles.day, { borderColor: c.controlLine, backgroundColor: c.surface }, pressed && { opacity: 0.6 }]}
        >
          <Text variant="body" numberOfLines={1}>
            {mediumDay(draft[dayField], locale)}
          </Text>
        </Pressable>
        {!draft.allDay ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${label} ${clockLabel(draft[timeField], locale)}`}
            onPress={() => pick(timeField)}
            style={({ pressed }) => [styles.box, { borderColor: c.controlLine, backgroundColor: c.surface }, pressed && { opacity: 0.6 }]}
          >
            <Text variant="label" style={styles.clock}>
              {clockLabel(draft[timeField], locale)}
            </Text>
          </Pressable>
        ) : null}
      </View>
    );
  };
  return (
    <>
      <FormRow icon={CalendarDays} tint={c.sky}>
        {end("start")}
      </FormRow>
      <FormRow icon={Clock} tint={c.violet}>
        {end("end")}
        {error ? (
          <Text variant="small" tone="danger">
            {error}
          </Text>
        ) : null}
      </FormRow>
      <FormRow icon={Sun} tint={c.sun}>
        <View style={styles.switchLine}>
          <Text variant="body" style={styles.flex}>
            {t("calendar.allDayEvent")}
          </Text>
          <Toggle
            value={draft.allDay}
            onValueChange={(allDay) => updateDraft(formKey, (d) => ({ ...d, allDay }))}
            accessibilityLabel={t("calendar.allDayEvent")}
          />
        </View>
      </FormRow>
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  line: { flexDirection: "row", alignItems: "center", gap: 8 },
  label: { flexShrink: 0 },
  day: { flex: 1, minHeight: 40, justifyContent: "center", borderWidth: hairline, borderRadius: radius.m, paddingHorizontal: 12 },
  box: { minWidth: 76, minHeight: 40, alignItems: "center", justifyContent: "center", borderWidth: hairline, borderRadius: radius.m, paddingHorizontal: 10 },
  clock: { fontSize: 17, lineHeight: 22 },
  switchLine: { flexDirection: "row", alignItems: "center", gap: 12 },
});
