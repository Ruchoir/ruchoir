import DateTimePicker from "@react-native-community/datetimepicker";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { useTranslation } from "../../../i18n";
import { useLocale } from "../../../i18n/useLocale";
import { setWhen } from "../../../logic/eventForm";
import type { RootParams } from "../../../navigation/types";
import { useTheme } from "../../../theme/useTheme";
import { Button } from "../../../ui/Button";
import { Sheet } from "../../../ui/Sheet";
import { Text } from "../../../ui/Text";
import { readDraft, updateDraft } from "./draftStore";
import { fromPicked, whenDate } from "./when";

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
  const day = params.field === "startDay" || params.field === "endDay";
  const [value, setValue] = useState(() => (draft ? whenDate(draft, params.field) : new Date()));
  if (!draft) return null;
  const apply = () => {
    updateDraft(params.formKey, (d) => setWhen(d, params.field, fromPicked(value, params.field)));
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
          minimumDate={params.field === "endDay" ? whenDate(draft, "startDay") : undefined}
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
