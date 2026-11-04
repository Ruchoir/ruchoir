/**
 * The end of a guest's access when inviting (mockup 14, left): ready-made durations, a day picked on
 * the phone's calendar, or no end; the day it comes to, and what the reminders will be. It holds no
 * state: the screen keeps the choice and turns it into an instant with `presetToInstant`, in the
 * profile zone, else the phone's (`useLocale().timeZone`), as the web's `EndDateField` does for its browser's.
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
import { pickedDay, pickedFromEvent, shortDay } from "../logic/memberScreen";
import { styleCache } from "../theme/themedStyles";
import { useTheme, useThemedStyles } from "../theme/useTheme";
import { feel } from "./haptics";
import { Text } from "./Text";

type Option = EndChoice | "custom";
const PRESETS: Option[] = ["week", "month", "quarter", "custom", "none"];
const LABEL: Record<"week" | "month" | "quarter" | "custom", ReturnType<typeof key>> = {
  week: key("guests.presetWeek"),
  month: key("guests.presetMonth"),
  quarter: key("guests.presetQuarter"),
  custom: key("guests.presetCustom"),
};

/**
 * `choice` is null while nothing is chosen (prolonging starts there). `title` replaces the heading,
 * `noneLabel` the last pill (prolonging says "Enlever la date"), and `summary` false leaves out the
 * day it comes to and the reminders (the caller adds a base the duration is counted from).
 */
export function EndDateChoice({
  choice,
  onChange,
  title,
  noneLabel,
  summary = true,
  disabled = false,
}: {
  choice: EndChoice | null;
  onChange: (choice: EndChoice) => void;
  title?: string;
  noneLabel?: ReturnType<typeof key>;
  summary?: boolean;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const { c, s, dark } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { locale, timeZone: zone } = useLocale();
  const [picking, setPicking] = useState(false);
  // Read at each render: a screen left open past midnight must not offer yesterday.
  const now = new Date();
  const custom = typeof choice === "object" && choice !== null;
  const bounds = dateBounds(now, zone);
  const instant = summary && choice !== null && choiceRefusal(choice, now, zone) === null ? presetToInstant(choice, now, zone) : null;
  const customLabel = custom ? shortDay(presetToInstant(choice, now, zone) ?? now.toISOString(), locale, zone, now) : t(LABEL.custom);

  const pickDate = () => {
    const start = custom ? new Date(`${choice.date}T12:00:00`) : new Date();
    if (Platform.OS === "android") {
      DateTimePickerAndroid.open({
        value: start,
        mode: "date",
        minimumDate: new Date(`${bounds.min}T00:00:00`),
        maximumDate: new Date(`${bounds.max}T23:59:59`),
        onChange: (event, date) => {
          const day = pickedFromEvent(event, date);
          if (day) onChange({ date: day });
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
        {title ?? t("guests.endTitle")} {title ? null : <Text variant="tiny" tone="muted">{t("guests.optional")}</Text>}
      </Text>
      <View style={styles.wrap}>
        {PRESETS.map((option) => {
          const on = option === "custom" ? custom : choice === option;
          const label = option === "custom" ? customLabel : option === "none" ? t(noneLabel ?? key("guests.presetNoEnd")) : t(LABEL[option as keyof typeof LABEL]);
          return (
            <Pressable
              key={String(option)}
              disabled={disabled}
              accessibilityRole="button"
              accessibilityState={{ selected: on, disabled }}
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
              <Text variant={on ? "smallStrong" : "small"}>{label}</Text>
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
          onChange={(event, date) => {
            const day = pickedFromEvent(event, date);
            if (day) onChange({ date: day });
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
