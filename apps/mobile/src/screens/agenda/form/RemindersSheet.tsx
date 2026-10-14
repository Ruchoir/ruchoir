import { getEvent, listCalendars, setEventMe } from "@ruchoir/client";
import { customMinutes, MAX_REMINDERS, presetReminders, reminderLabel, remindersLabel, type ReminderUnit } from "@ruchoir/client/calendarLogic";
import { useRoute, type RouteProp } from "@react-navigation/native";
import { Bell, CalendarDays, Plus, SlidersHorizontal, SquarePen, X } from "lucide-react-native";
import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { useLoad } from "../../../data/useLoad";
import { key, useTranslation } from "../../../i18n";
import { useSharedT } from "../../../i18n/sharedT";
import type { RootParams } from "../../../navigation/types";
import { useTheme } from "../../../theme/useTheme";
import { ActionRow } from "../../../ui/ActionRow";
import { Button } from "../../../ui/Button";
import { Segmented } from "../../../ui/Segmented";
import { Sheet } from "../../../ui/Sheet";
import { LoadState } from "../../../ui/States";
import { Text } from "../../../ui/Text";
import { useToast } from "../../../ui/Toast";
import { updateDraft, useDraft } from "./draftStore";
import { Stepper } from "./Stepper";

const UNITS = [
  { key: "minutes", label: key("calendar.reminderUnit.minutes") },
  { key: "hours", label: key("calendar.reminderUnit.hours") },
  { key: "days", label: key("calendar.reminderUnit.days") },
  { key: "weeks", label: key("calendar.reminderUnit.weeks") },
] as const;

/** The reminders a calendar gives a timed event of the person, as the web counts them. */
export function inheritedReminders(calendar: { myReminders?: number[]; defaultReminders: number[] } | undefined, allDay: boolean): number[] {
  return allDay ? [] : (calendar?.myReminders ?? calendar?.defaultReminders ?? []);
}

/**
 * Reminders (the web's `RemindersField`): following the calendar's ("Comme l'agenda : 15 min
 * avant") until someone chooses their own; then a list, each removable, the usual delays to add, a
 * delay of one's own, five at most, and the way back to the calendar's.
 */
export function RemindersEditor({
  value,
  inherited,
  allDay,
  onChange,
}: {
  value: number[] | undefined;
  inherited?: number[];
  allDay: boolean;
  onChange: (next: number[] | undefined) => void;
}) {
  const { t } = useTranslation();
  const say = useSharedT();
  const { c, s } = useTheme();
  const [custom, setCustom] = useState(false);
  const [count, setCount] = useState(1);
  const [unit, setUnit] = useState<ReminderUnit>("hours");
  if (value === undefined) {
    return (
      <>
        <Text variant="body" tone="body">
          {t("calendar.reminderFollowsCalendar", { label: remindersLabel(inherited ?? [], say, allDay) })}
        </Text>
        <ActionRow icon={SquarePen} tint={c.pink} title={t("calendar.reminderPersonalize")} onPress={() => onChange([...(inherited ?? [])])} />
      </>
    );
  }
  // Earliest first: the order they ring in.
  const shown = [...value].sort((a, b) => b - a);
  const full = value.length >= MAX_REMINDERS;
  const offered = presetReminders(allDay).filter((m) => !value.includes(m));
  const add = (minutes: number | null) => {
    if (minutes === null || value.includes(minutes) || full) return;
    onChange([...value, minutes]);
    setCustom(false);
  };
  const typed = customMinutes(count, allDay ? "days" : unit, allDay);
  return (
    <>
      {shown.length === 0 ? (
        <Text variant="body" tone="muted">
          {t("calendar.reminderNone")}
        </Text>
      ) : null}
      {shown.map((m) => (
        <ActionRow
          key={m}
          icon={Bell}
          tint={c.pink}
          title={reminderLabel(m, say, allDay)}
          trailing={
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("calendar.reminderRemove", { label: reminderLabel(m, say, allDay) })}
              hitSlop={10}
              onPress={() => onChange(value.filter((k) => k !== m))}
              style={({ pressed }) => [styles.remove, { backgroundColor: s.sunken }, pressed && { opacity: 0.6 }]}
            >
              <X size={16} color={c.ink} />
            </Pressable>
          }
        />
      ))}
      {full ? (
        <Text variant="tiny" tone="muted">
          {t("calendar.remindersMax")}
        </Text>
      ) : (
        <>
          <Text variant="smallStrong" tone="muted" style={styles.group}>
            {t("calendar.addReminder")}
          </Text>
          {offered.map((m) => (
            <ActionRow key={m} icon={Plus} title={reminderLabel(m, say, allDay)} onPress={() => add(m)} />
          ))}
          <ActionRow icon={SlidersHorizontal} title={t("calendar.customReminder")} onPress={() => setCustom(!custom)} />
          {custom ? (
            <View style={styles.custom}>
              <View style={styles.inline}>
                <Stepper value={count} min={allDay ? 1 : 0} max={allDay ? 28 : 99} onChange={setCount} label={t("calendar.customReminder")} />
                {allDay ? <Text variant="body">{t("calendar.reminderDaysAt9Unit")}</Text> : null}
              </View>
              {!allDay ? (
                <Segmented<ReminderUnit>
                  options={UNITS.map((u) => ({ key: u.key, label: t(u.label) }))}
                  value={unit}
                  onChange={setUnit}
                  style={styles.flush}
                />
              ) : null}
              <Button variant="secondary" size="md" label={t("group.addExternal")} disabled={typed === null || value.includes(typed)} onPress={() => add(typed)} />
            </View>
          ) : null}
        </>
      )}
      {inherited !== undefined ? (
        <ActionRow icon={CalendarDays} tint={c.sky} title={t("calendar.reminderBackToCalendar")} onPress={() => onChange(undefined)} />
      ) : null}
    </>
  );
}

/** The reminders of the event form's draft, or one's own for an event (saved at once). */
export function RemindersSheet() {
  const { params } = useRoute<RouteProp<RootParams, "eventReminders">>();
  return params.eventId ? <OwnReminders eventId={params.eventId} /> : <DraftReminders formKey={params.formKey ?? ""} />;
}

/**
 * One's own reminders for an event, which anyone who sees it may set, whether or not they may
 * change it: each change is saved at once, and a failure puts back what was there.
 */
function OwnReminders({ eventId }: { eventId: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const loaded = useLoad(`reminders:${eventId}`, async (signal) => {
    const [event, calendars] = await Promise.all([getEvent(eventId, signal), listCalendars(signal)]);
    return { event, calendar: calendars.find((cal) => cal.id === event.calendarId) };
  });
  // `null` until changed here; `undefined` follows the calendar's.
  const [value, setValue] = useState<number[] | undefined | null>(null);
  if (!loaded.data) {
    return (
      <Sheet>
        <LoadState error={loaded.error} onRetry={loaded.reload} />
      </Sheet>
    );
  }
  const { event, calendar } = loaded.data;
  return (
    <Sheet>
      <Text variant="heading">{t("calendar.myReminder")}</Text>
      <RemindersEditor
        value={value === null ? event.myOwnReminders : value}
        inherited={inheritedReminders(calendar, event.allDay)}
        allDay={event.allDay}
        onChange={(next) => {
          setValue(next);
          setEventMe(eventId, next ?? "default").catch(() => {
            setValue(null);
            toast(t("eventForm.saveFailed"), "failure");
          });
        }}
      />
    </Sheet>
  );
}

function DraftReminders({ formKey }: { formKey: string }) {
  const { t } = useTranslation();
  const draft = useDraft(formKey);
  const calendars = useLoad("calendars", (signal) => listCalendars(signal));
  if (!draft) return null;
  const calendar = calendars.data?.find((cal) => cal.id === draft.calendarId);
  return (
    <Sheet>
      <Text variant="heading">{t("calendar.myReminder")}</Text>
      <RemindersEditor
        value={draft.reminders}
        inherited={inheritedReminders(calendar, draft.allDay)}
        allDay={draft.allDay}
        onChange={(reminders) => updateDraft(formKey, (d) => ({ ...d, reminders, remindersTouched: true }))}
      />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  group: { marginTop: 10 },
  remove: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  custom: { gap: 10, paddingVertical: 6 },
  inline: { flexDirection: "row", alignItems: "center", gap: 10 },
  flush: { marginHorizontal: 0 },
});
