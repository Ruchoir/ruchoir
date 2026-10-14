import DateTimePicker from "@react-native-community/datetimepicker";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { useTranslation } from "../../../i18n";
import { useLocale } from "../../../i18n/useLocale";
import { setWhen, type EventDraft } from "../../../logic/eventForm";
import type { RootParams } from "../../../navigation/types";
import { useTheme } from "../../../theme/useTheme";
import { Button } from "../../../ui/Button";
import { Sheet } from "../../../ui/Sheet";
import { Text } from "../../../ui/Text";
import { readDraft, updateDraft } from "./draftStore";
import { fromPicked, whenDate } from "./when";

/** The day a custom repetition stops, or its start when it has none yet. */
function untilDate(d: EventDraft): Date {
  return whenDate({ ...d, startDay: d.custom.end.kind === "until" ? d.custom.end.date : d.startDay }, "startDay");
}

/**
 * The phone's own date or time picker for one field of the event form (iOS): the calendar of the
 * month for a day, the wheels for a time, in the language of the app. "OK" sets the field, through
 * its rule (the end follows the start).
 */
export function PickerSheet() {
  const { params } = useRoute<RouteProp<RootParams, "eventPicker">>();
  const navigation = useNavigation();
  const { t } = useTranslation();
  const { dark } = useTheme();
  const { locale } = useLocale();
  const draft = readDraft(params.formKey);
  const field = params.field;
  const day = field !== "startTime" && field !== "endTime";
  const [value, setValue] = useState(() => (!draft ? new Date() : field === "until" ? untilDate(draft) : whenDate(draft, field)));
  if (!draft) return null;
  const apply = () => {
    if (field === "until") {
      const date = fromPicked(value, "startDay");
      updateDraft(params.formKey, (d) => ({ ...d, custom: { ...d.custom, end: { kind: "until", date } }, preset: "custom", ruleTouched: true }));
    } else {
      updateDraft(params.formKey, (d) => setWhen(d, field, fromPicked(value, field)));
    }
    navigation.goBack();
  };
  return (
    <Sheet>
      <Text variant="heading">{day ? t("eventForm.pickDate") : t("eventForm.pickTime")}</Text>
      <View style={styles.picker}>
        <DateTimePicker
          value={value}
          mode={day ? "date" : "time"}
          display={day ? "inline" : "spinner"}
          locale={locale}
          themeVariant={dark ? "dark" : "light"}
          minimumDate={field === "endDay" || field === "until" ? whenDate(draft, "startDay") : undefined}
          onChange={(_, next) => {
            if (next) setValue(next);
          }}
        />
      </View>
      <Button label={t("compose.ok")} onPress={apply} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  picker: { alignItems: "center", paddingVertical: 8 },
});
