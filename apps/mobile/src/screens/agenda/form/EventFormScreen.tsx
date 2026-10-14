/**
 * "New event" (mockup 19): a full-screen form, the band in the chosen calendar's colour with the
 * title and the calendar, then when, and what goes with it. Its draft lives in `draftStore` under a
 * key of its own, so the sheets it opens (calendar, pickers...) read and change it; closing with
 * something typed asks first, and a failure keeps everything typed.
 */
import { createEvent, listCalendars, type Calendar } from "@ruchoir/client";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { remindersLabel } from "@ruchoir/client/calendarLogic";
import { Bell, ChevronDown, ChevronRight, FileText, MapPin, Repeat } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, TextInput, View } from "react-native";

import { useLoad } from "../../../data/useLoad";
import { useTranslation } from "../../../i18n";
import { useSharedT } from "../../../i18n/sharedT";
import { useLocale } from "../../../i18n/useLocale";
import { dayKey } from "../../../logic/format";
import { isDirty, newDraft, toInput, type DraftError, type EventDraft } from "../../../logic/eventForm";
import type { RootParams } from "../../../navigation/types";
import { useSpace } from "../../../space/SpaceProvider";
import { fonts } from "../../../theme/fonts";
import { hairline, mix } from "../../../theme/tokens";
import { useTheme } from "../../../theme/useTheme";
import { Button } from "../../../ui/Button";
import { KeyboardForm } from "../../../ui/KeyboardForm";
import { SheetHeader } from "../../../ui/SheetHeader";
import { LoadState } from "../../../ui/States";
import { Text } from "../../../ui/Text";
import { useToast } from "../../../ui/Toast";
import { calendarColor } from "../calendarColor";
import { calendarLabel } from "../calendarLabel";
import { closeDraft, openDraft, readDraft, updateDraft, useDraft } from "./draftStore";
import { FormRow } from "./FormRow";
import { inheritedReminders } from "./RemindersSheet";
import { repeatLabel } from "./repeat";
import { WhenRows } from "./WhenRows";

let forms = 0;

export function EventFormScreen() {
  const { params } = useRoute<RouteProp<RootParams, "eventForm">>();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const { t } = useTranslation();
  const { c } = useTheme();
  const { locale, timeZone } = useLocale();
  const say = useSharedT();
  const toast = useToast();
  const { spaces } = useSpace();
  const [formKey] = useState(() => `event-form-${++forms}`);
  const calendars = useLoad("calendars", (signal) => listCalendars(signal));
  const draft = useDraft(formKey);
  const initial = useRef<EventDraft | null>(null);
  const saved = useRef(false);
  const [error, setError] = useState<DraftError | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  // The draft opens once the calendars are known (the first one is the person's own).
  useEffect(() => {
    if (!calendars.data || initial.current) return;
    const fresh = newDraft({
      day: params.day ?? dayKey(new Date(), timeZone),
      now: new Date(),
      timeZone,
      calendars: calendars.data,
      channelId: params.channelId,
    });
    initial.current = fresh;
    openDraft(formKey, fresh);
  }, [calendars.data, formKey, params.day, params.channelId, timeZone]);
  useEffect(() => () => closeDraft(formKey), [formKey]);

  // Leaving with something typed asks first; leaving after saving does not.
  useEffect(
    () =>
      navigation.addListener("beforeRemove", (e) => {
        const current = initial.current;
        if (saved.current || !current) return;
        const now = readDraft(formKey);
        if (!now || !isDirty(now, current)) return;
        e.preventDefault();
        Alert.alert(t("eventForm.discardTitle"), t("eventForm.discardText"), [
          { text: t("eventForm.keepEditing"), style: "cancel" },
          { text: t("eventForm.discard"), style: "destructive", onPress: () => navigation.dispatch(e.data.action) },
        ]);
      }),
    [navigation, formKey, t],
  );

  const calendar: Calendar | undefined = calendars.data?.find((cal) => cal.id === draft?.calendarId);
  const band = mix(calendarColor(calendar?.color, c), c.surface, 0.45);

  const save = async () => {
    if (!draft) return;
    const body = toInput(draft, false);
    if ("error" in body) {
      setError(body.error);
      return;
    }
    setError(null);
    setBusy(true);
    setFailed(false);
    try {
      await createEvent(draft.calendarId, body);
      saved.current = true;
      navigation.goBack();
      toast(t("eventForm.saved"));
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };

  const errorText = (which: DraftError) =>
    error !== which ? undefined : which === "titleRequired" ? t("calendar.titleRequired") : t("calendar.endBeforeStart");

  return (
    <View style={[styles.fill, { backgroundColor: c.surface }]}>
      <SheetHeader title={t("calendar.newEvent")} onClose={() => navigation.goBack()} />
      {!draft ? (
        <LoadState error={calendars.error} onRetry={calendars.reload} />
      ) : (
        <KeyboardForm
          keyboardDismissMode="on-drag"
          contentContainerStyle={styles.form}
          footer={
            <View style={[styles.foot, { borderTopColor: c.line, backgroundColor: c.surface }]}>
              {failed ? (
                <Text variant="small" tone="danger">
                  {t("eventForm.saveFailed")}
                </Text>
              ) : null}
              <Button label={t("eventForm.save")} busy={busy} disabled={!draft.calendarId} onPress={() => void save()} />
            </View>
          }
        >
          <View style={[styles.band, { backgroundColor: band }]}>
            <TextInput
              value={draft.title}
              onChangeText={(title) => updateDraft(formKey, (d) => ({ ...d, title }))}
              placeholder={t("calendar.eventTitlePlaceholder")}
              placeholderTextColor={mix(c.onPastel, band, 0.55)}
              accessibilityLabel={t("calendar.eventTitle")}
              autoFocus
              autoCapitalize="sentences"
              maxLength={500}
              returnKeyType="done"
              style={[styles.title, { color: c.onPastel }]}
            />
            {errorText("titleRequired") ? (
              <Text variant="small" style={{ color: c.onPastel }}>
                {errorText("titleRequired")}
              </Text>
            ) : null}
            {calendar ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${t("eventForm.chooseCalendar")} ${calendar.name}`}
                onPress={() => navigation.navigate("eventCalendar", { formKey })}
                style={({ pressed }) => [styles.calendar, { borderColor: c.onPastel }, pressed && { opacity: 0.6 }]}
              >
                <View style={[styles.dot, { backgroundColor: calendarColor(calendar.color, c), borderColor: c.onPastel }]} />
                <Text variant="smallStrong" numberOfLines={1} style={[styles.calendarName, { color: c.onPastel }]}>
                  {[calendarLabel(calendar, spaces.data ?? []).sub, calendar.name].filter(Boolean).join(" · ")}
                </Text>
                <ChevronDown size={16} color={c.onPastel} />
              </Pressable>
            ) : null}
          </View>
          <WhenRows formKey={formKey} draft={draft} error={errorText("endBeforeStart")} />
          <FormRow icon={Repeat} tint={c.lime} label={t("calendar.repeat")} onPress={() => navigation.navigate("eventRepeat", { formKey })}>
            <View style={styles.choice}>
              <Text variant="body" style={styles.grow}>
                {repeatLabel(draft, locale, say, { none: t("calendar.repeatNone"), imported: t("calendar.importedRule") })}
              </Text>
              <ChevronRight size={18} color={c.muted} />
            </View>
          </FormRow>
          <FormRow icon={Bell} tint={c.pink} label={t("calendar.myReminder")} onPress={() => navigation.navigate("eventReminders", { formKey })}>
            <View style={styles.choice}>
              <Text variant="body" style={styles.grow}>
                {draft.reminders === undefined
                  ? t("calendar.reminderFollowsCalendar", { label: remindersLabel(inheritedReminders(calendar, draft.allDay), say, draft.allDay) })
                  : remindersLabel(draft.reminders, say, draft.allDay)}
              </Text>
              <ChevronRight size={18} color={c.muted} />
            </View>
          </FormRow>
          <FormRow icon={MapPin} tint={c.mint}>
            <TextInput
              value={draft.location}
              onChangeText={(location) => updateDraft(formKey, (d) => ({ ...d, location }))}
              placeholder={t("calendar.addLocation")}
              placeholderTextColor={c.muted}
              accessibilityLabel={t("calendar.location")}
              maxLength={500}
              style={[styles.input, { color: c.ink }]}
            />
          </FormRow>
          <FormRow icon={FileText} tint={c.peach} align="start">
            <TextInput
              value={draft.description}
              onChangeText={(description) => updateDraft(formKey, (d) => ({ ...d, description }))}
              placeholder={t("calendar.addNotes")}
              placeholderTextColor={c.muted}
              accessibilityLabel={t("calendar.notes")}
              maxLength={20000}
              multiline
              style={[styles.input, styles.notes, { color: c.ink }]}
            />
          </FormRow>
        </KeyboardForm>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  grow: { flex: 1 },
  choice: { flexDirection: "row", alignItems: "center", gap: 8 },
  form: { paddingBottom: 24 },
  band: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 14, gap: 10 },
  title: { fontFamily: fonts.sansBold, fontSize: 24, lineHeight: 30, paddingVertical: 4 },
  calendar: { flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "flex-start", maxWidth: "100%", paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, borderWidth: hairline },
  calendarName: { flexShrink: 1 },
  dot: { width: 12, height: 12, borderRadius: 6, borderWidth: 1 },
  input: { fontFamily: fonts.sans, fontSize: 16, lineHeight: 21, paddingVertical: 6 },
  notes: { minHeight: 72, textAlignVertical: "top" },
  foot: { gap: 8, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, borderTopWidth: hairline },
});
