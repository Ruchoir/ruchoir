/**
 * The end of a guest's access when inviting (mockup 14, left): ready-made durations, a day picked on
 * the phone's calendar, or no end; the day it comes to, and what the reminders will be. It holds no
 * state: the screen keeps the choice and turns it into an instant with `presetToInstant`, in the
 * phone's zone (`deviceZone`), as the web's `EndDateField` does for its browser's.
 */
import {
  choiceRefusal,
  dateBounds,
  endLabel,
  presetToInstant,
  type EndChoice,
} from "@ruchoir/client/permissionsLogic";
import DateTimePicker, { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import { useState } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";

import { key, useTranslation } from "../i18n";
import { useLocale } from "../i18n/useLocale";
import { deviceZone, pickedDay } from "../logic/memberScreen";
import { styleCache } from "../theme/themedStyles";
import { useTheme, useThemedStyles } from "../theme/useTheme";
import { feel } from "./haptics";
import { Text } from "./Text";

const CHOICES: { choice: EndChoice | "custom"; label: ReturnType<typeof key> }[] = [
  { choice: "week", label: key("guests.presetWeek") },
  { choice: "month", label: key("guests.presetMonth") },
  { choice: "quarter", label: key("guests.presetQuarter") },
  { choice: "custom", label: key("guests.presetCustom") },
  { choice: "none", label: key("guests.presetNoEnd") },
];

export function EndDateChoice({ choice, onChange }: { choice: EndChoice; onChange: (choice: EndChoice) => void }) {
  const { t } = useTranslation();
  const { c, s, dark } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { locale } = useLocale();
  const zone = deviceZone();
  const [now] = useState(() => new Date());
  const [picking, setPicking] = useState(false);
  const custom = typeof choice === "object";
  const bounds = dateBounds(now, zone);
  const instant = choiceRefusal(choice, now, zone) === null ? presetToInstant(choice, now, zone) : null;

  const pickDate = () => {
    const start = custom ? new Date(`${choice.date}T12:00:00`) : new Date();
    if (Platform.OS === "android") {
      DateTimePickerAndroid.open({
        value: start,
        mode: "date",
        minimumDate: new Date(`${bounds.min}T00:00:00`),
        maximumDate: new Date(`${bounds.max}T23:59:59`),
        onChange: (_, date) => {
          if (date) onChange({ date: pickedDay(date) });
        },
      });
    } else {
      setPicking((on) => !on);
      if (!custom) onChange({ date: pickedDay(start) });
    }
  };

  return (
    <View style={styles.block}>
      <Text variant="label" tone="muted">
        {t("guests.endTitle")} <Text variant="tiny" tone="muted">{t("guests.optional")}</Text>
      </Text>
      <View style={styles.wrap}>
        {CHOICES.map(({ choice: option, label }) => {
          const on = option === "custom" ? custom : choice === option;
          return (
            <Pressable
              key={String(option)}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              onPress={() => {
                feel("choice");
                if (option === "custom") pickDate();
                else {
                  setPicking(false);
                  onChange(option);
                }
              }}
              style={[styles.pill, { borderColor: on ? s.edge : c.lineStrong, backgroundColor: on ? s.selected : c.surface }]}
            >
              <Text variant={on ? "smallStrong" : "small"}>{t(label)}</Text>
            </Pressable>
          );
        })}
      </View>
      {picking && Platform.OS === "ios" && custom ? (
        <DateTimePicker
          value={new Date(`${choice.date}T12:00:00`)}
          mode="date"
          display="inline"
          locale={locale}
          themeVariant={dark ? "dark" : "light"}
          minimumDate={new Date(`${bounds.min}T00:00:00`)}
          maximumDate={new Date(`${bounds.max}T23:59:59`)}
          onChange={(_, date) => {
            if (date) onChange({ date: pickedDay(date) });
          }}
        />
      ) : null}
      {instant ? (
        <>
          <View style={[styles.result, { borderColor: c.lineStrong }]}>
            <View>
              <Text variant="tiny" tone="muted">
                {t("guests.dateLabel")}
              </Text>
              <Text variant="tiny" tone="muted">
                {t("guests.endOfDay")}
              </Text>
            </View>
            <Text variant="bodyStrong">{endLabel(instant, locale, zone)}</Text>
          </View>
          <Text variant="small" tone="muted">
            {t("guests.reminders")}
          </Text>
        </>
      ) : null}
    </View>
  );
}

const makeStyles = styleCache((shape) =>
  StyleSheet.create({
    block: { gap: 8 },
    wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    pill: { height: 34, paddingHorizontal: 14, borderRadius: 17, borderWidth: shape.hairline, alignItems: "center", justifyContent: "center" },
    result: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, padding: 12, borderWidth: shape.hairline, borderRadius: shape.radius.m },
  }),
);
