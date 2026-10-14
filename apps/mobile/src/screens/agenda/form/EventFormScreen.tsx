/**
 * "New event" (mockup 19), or "Edit event" from its summary: a full-screen form, the band in the
 * chosen calendar's colour with the title and the calendar, then when, and what goes with it. A change
 * to a date of a series asks first whether it is for that date, the following ones or all of them. Its draft lives in `draftStore` under a
 * key of its own, so the sheets it opens (calendar, pickers...) read and change it; closing with
 * something typed asks first, and a failure keeps everything typed.
 */
import {
  createEvent,
  isApiError,
  listCalendars,
  listLinkableChannels,
  searchInvitees,
  setEventMe,
  updateEvent,
  type Calendar,
  type EditScope,
  type SpaceFile,
} from "@ruchoir/client";
import { StackActions, useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { remindersLabel } from "@ruchoir/client/calendarLogic";
import { Bell, ChevronDown, ChevronRight, FileText, Globe, MapPin, MessageSquare, Paperclip, Repeat, UserPlus, Users } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, TextInput, View } from "react-native";

import { useAttachRequests } from "../../../compose/requests";
import { useLoad } from "../../../data/useLoad";
import { useTranslation } from "../../../i18n";
import { useSharedT } from "../../../i18n/sharedT";
import { useLocale } from "../../../i18n/useLocale";
import { dayKey } from "../../../logic/format";
import { draftFromEvent, isDirty, leaveForm, newDraft, toInput, wholeSeriesInput, type DraftError, type EventDraft } from "../../../logic/eventForm";
import type { RootParams } from "../../../navigation/types";
import { useSession } from "../../../session/SessionProvider";
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
import { loadOccurrence } from "../loadOccurrence";
import { closeDraft, openDraft, readDraft, updateDraft, useDraft } from "./draftStore";
import { Availability } from "./Availability";
import { ClashLine } from "./ClashLine";
import { FormRow } from "./FormRow";
import { EventFiles } from "./EventFiles";
import { InviteeChips } from "./InviteeChips";
import { inheritedReminders } from "./RemindersSheet";
import { repeatLabel } from "./repeat";
import { useScopeRequests } from "./scope";
import { MAX_EVENT_FILES, useEventUploads } from "./useEventUploads";
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
  const { state } = useSession();
  const me = state.kind === "signedIn" ? state.user : null;
  const [formKey] = useState(() => `event-form-${++forms}`);
  const calendars = useLoad("calendars", (signal) => listCalendars(signal));
  // The event changed, and the date of it opened.
  const editing = useLoad(params.eventId ? `edit:${params.eventId}:${params.recurrenceId ?? ""}` : null, (signal) =>
    loadOccurrence(params.eventId!, params.recurrenceId, params.start, signal),
  );
  const edit = editing.data;
  const draft = useDraft(formKey);
  const initial = useRef<EventDraft | null>(null);
  const saved = useRef(false);
  // A save in flight holds the form open; a form gone by then is told nothing.
  const saving = useRef(false);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const [error, setError] = useState<DraftError | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busyNames, setBusyNames] = useState<string[]>([]);
  const uploads = useEventUploads(formKey, calendars.data);
  const linkable = useLoad(draft ? `linkable:${draft.calendarId}` : null, (signal) => listLinkableChannels(draft!.calendarId, signal));
  const [invitingAll, setInvitingAll] = useState(false);

  const addSpaceFile = (file: SpaceFile) => {
    const id = file.id;
    if (!id) return;
    updateDraft(formKey, (d) =>
      d.files.some((f) => f.id === id) || d.files.length >= MAX_EVENT_FILES
        ? d
        : { ...d, files: [...d.files, { id, name: file.name, size: file.sizeBytes }], filesTouched: true },
    );
  };
  // Files picked in the attach sheet: the phone's are uploaded, the space's join as they are.
  useAttachRequests(`event:${formKey}`, (request) => {
    if (request.kind === "local") {
      void uploads.add(request.files);
      return;
    }
    addSpaceFile(request.file);
  });
  /** Everyone of the channel who may be invited, added to the list (once each). */
  const inviteChannel = async () => {
    if (!draft?.channelId) return;
    setInvitingAll(true);
    try {
      const people = await searchInvitees(draft.calendarId, "", undefined, draft.channelId);
      updateDraft(formKey, (d) => {
        const fresh = people.filter((p) => !d.attendees.some((a) => a.userId === p.userId));
        if (fresh.length === 0) return d;
        return { ...d, attendees: [...d.attendees, ...fresh.map((p) => ({ key: p.userId, userId: p.userId, name: p.name }))], attendeesTouched: true };
      });
    } catch {
      toast(t("load.failed"));
    } finally {
      setInvitingAll(false);
    }
  };

  // The draft opens once the calendars are known (a new event goes to the person's own), and the
  // event, for a change.
  useEffect(() => {
    if (!calendars.data || initial.current || (params.eventId && !edit)) return;
    const fresh = edit
      ? draftFromEvent(edit.occurrence, edit.event, timeZone)
      : newDraft({ day: params.day ?? dayKey(new Date(), timeZone), now: new Date(), timeZone, calendars: calendars.data, channelId: params.channelId });
    initial.current = fresh;
    openDraft(formKey, fresh);
  }, [calendars.data, edit, formKey, params.eventId, params.day, params.channelId, timeZone]);
  useEffect(() => () => closeDraft(formKey), [formKey]);

  // Leaving with something typed asks first; leaving after saving does not.
  useEffect(
    () =>
      navigation.addListener("beforeRemove", (e) => {
        const current = initial.current;
        const now = readDraft(formKey);
        const choice = leaveForm({ saved: saved.current, saving: saving.current, dirty: !!current && !!now && isDirty(now, current) });
        if (choice === "leave") return;
        e.preventDefault();
        if (choice === "stay") return;
        Alert.alert(t("eventForm.discardTitle"), t("eventForm.discardText"), [
          { text: t("eventForm.keepEditing"), style: "cancel" },
          { text: t("eventForm.discard"), style: "destructive", onPress: () => navigation.dispatch(e.data.action) },
        ]);
      }),
    [navigation, formKey, t],
  );

  // Who is free, for a timed event with someone of the instance invited.
  const showAvailability = !!draft && !draft.allDay && draft.attendees.some((a) => a.userId && a.userId !== me?.id);
  const calendar: Calendar | undefined = calendars.data?.find((cal) => cal.id === draft?.calendarId);
  const band = mix(calendarColor(calendar?.color, c), c.surface, 0.45);

  // A date of a series: its calendar is the series', and a change asks for its scope.
  const seriesDate = !!(edit?.event.isRecurring && edit.occurrence.recurrenceId);

  /** Close the form, and the summary it was opened from (it shows what was). */
  const done = (message: "saved" | "gone") => {
    saved.current = true;
    const routes = navigation.getState().routes;
    navigation.dispatch(StackActions.pop(edit && routes[routes.length - 2]?.name === "eventSummary" ? 2 : 1));
    toast(message === "saved" ? t("eventForm.saved") : t("eventForm.gone"));
  };

  const save = async (scope?: EditScope) => {
    if (!draft || saving.current) return;
    const body = toInput(draft, !!edit);
    if ("error" in body) {
      setError(body.error);
      return;
    }
    setError(null);
    if (seriesDate && !scope) {
      navigation.navigate("eventScope", { key: formKey, title: draft.title.trim(), action: "edit" });
      return;
    }
    setBusy(true);
    setFailed(false);
    saving.current = true;
    try {
      if (!edit) {
        await createEvent(draft.calendarId, body);
      } else if (!edit.event.isRecurring || !scope || scope === "all") {
        await updateEvent(edit.event.eventId, wholeSeriesInput(body, edit.occurrence, edit.event, draft.calendarId, draft.tz), "all");
      } else {
        await updateEvent(edit.event.eventId, body, scope, edit.occurrence.recurrenceId);
      }
      // Back to the calendar's reminders: a change of one's own setting, not of the event.
      if (edit && draft.remindersTouched && draft.reminders === undefined) await setEventMe(edit.event.eventId, "default");
      saving.current = false;
      if (alive.current) done("saved");
    } catch (err) {
      saving.current = false;
      if (!alive.current) return;
      if (edit && isApiError(err, 404)) {
        done("gone");
        return;
      }
      setBusy(false);
      if (edit && isApiError(err, 403)) toast(t("eventForm.forbidden"));
      else setFailed(true);
    }
  };
  useScopeRequests(formKey, (scope) => void save(scope));

  const errorText = (which: DraftError) =>
    error !== which ? undefined : which === "titleRequired" ? t("calendar.titleRequired") : t("calendar.endBeforeStart");

  return (
    <View style={[styles.fill, { backgroundColor: c.surface }]}>
      <SheetHeader title={edit || params.eventId ? t("calendar.editEvent") : t("calendar.newEvent")} onClose={() => navigation.goBack()} />
      {!draft ? (
        <LoadState
          error={calendars.error ?? editing.error}
          onRetry={() => {
            calendars.reload();
            editing.reload();
          }}
        />
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
              <Button
                label={edit ? t("compose.save") : t("eventForm.save")}
                busy={busy}
                disabled={!draft.calendarId || uploads.uploading}
                onPress={() => void save()}
              />
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
              autoFocus={!params.eventId}
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
                accessibilityState={{ disabled: seriesDate }}
                disabled={seriesDate}
                onPress={() => navigation.navigate("eventCalendar", { formKey })}
                style={({ pressed }) => [styles.calendar, { borderColor: c.onPastel }, pressed && { opacity: 0.6 }]}
              >
                <View style={[styles.dot, { backgroundColor: calendarColor(calendar.color, c), borderColor: c.onPastel }]} />
                <Text variant="smallStrong" numberOfLines={1} style={[styles.calendarName, { color: c.onPastel }]}>
                  {[calendarLabel(calendar, spaces.data ?? []).sub, calendar.name].filter(Boolean).join(" · ")}
                </Text>
                {seriesDate ? null : <ChevronDown size={16} color={c.onPastel} />}
              </Pressable>
            ) : null}
          </View>
          <WhenRows formKey={formKey} draft={draft} error={errorText("endBeforeStart")} />
          {!draft.allDay && draft.tz !== timeZone ? (
            <FormRow icon={Globe} tint={c.sky} label={t("eventForm.timeZone")} onPress={() => navigation.navigate("eventZone", { formKey })}>
              <View style={styles.choice}>
                <View style={styles.grow}>
                  <Text variant="tiny" tone="muted">
                    {t("eventForm.timeZone")}
                  </Text>
                  <Text variant="body">{draft.tz.replace(/_/g, " ")}</Text>
                </View>
                <ChevronRight size={18} color={c.muted} />
              </View>
            </FormRow>
          ) : null}
          <ClashLine draft={draft} calendars={calendars.data ?? []} busyNames={showAvailability ? busyNames : []} eventId={params.eventId} />
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
          <FormRow icon={UserPlus} tint={c.sun} align="start">
            <Pressable
              accessibilityRole="button"
              onPress={() => navigation.navigate("eventInvitees", { formKey })}
              style={({ pressed }) => [styles.choice, pressed && { opacity: 0.6 }]}
            >
              <Text variant="body" tone={draft.attendees.length ? "strong" : "muted"} style={styles.grow}>
                {draft.attendees.length ? t("calendar.attendees") : t("eventForm.addInvitees")}
              </Text>
              <ChevronRight size={18} color={c.muted} />
            </Pressable>
            {draft.attendees.length > 0 ? (
              <>
                <InviteeChips formKey={formKey} attendees={draft.attendees} />
                <Text variant="tiny" tone="muted">
                  {t("eventForm.inviteNote")}
                </Text>
              </>
            ) : null}
            {showAvailability ? (
              <Availability
                formKey={formKey}
                draft={draft}
                me={me?.id}
                people={[
                  ...(me ? [{ userId: me.id, name: t("calendar.me") }] : []),
                  ...draft.attendees.flatMap((a) => (a.userId && a.userId !== me?.id ? [{ userId: a.userId, name: a.name }] : [])),
                ]}
                eventId={params.eventId}
                onBusy={setBusyNames}
              />
            ) : null}
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
          <FormRow icon={MessageSquare} tint={c.pink} align="start">
            <Pressable
              accessibilityRole="button"
              onPress={() => navigation.navigate("eventChannel", { formKey })}
              style={({ pressed }) => [styles.choice, pressed && { opacity: 0.6 }]}
            >
              <View style={styles.grow}>
                <Text variant="tiny" tone="muted">
                  {t("eventForm.shareInChannel")}
                </Text>
                <Text variant="bodyStrong" tone={draft.channelId ? "strong" : "muted"}>
                  {draft.channelId
                    ? (linkable.data?.find((ch) => ch.id === draft.channelId)?.name ??
                      (edit?.event.channel?.id === draft.channelId ? edit.event.channel?.name : undefined) ??
                      "…")
                    : t("calendar.noChannel")}
                </Text>
              </View>
              <ChevronRight size={18} color={c.muted} />
            </Pressable>
            {draft.channelId ? (
              <Button
                variant="secondary"
                size="sm"
                icon={<Users size={16} color={c.ink} />}
                label={t("calendar.inviteChannel")}
                busy={invitingAll}
                onPress={() => void inviteChannel()}
                style={styles.start}
              />
            ) : null}
          </FormRow>
          <FormRow icon={Paperclip} tint={c.peach} align="start">
            <EventFiles
              formKey={formKey}
              draft={draft}
              pending={uploads.pending}
              onAdd={() =>
                navigation.navigate("attachSheet", {
                  draftKey: `event:${formKey}`,
                  title: t("eventForm.addFile"),
                  spaceId: calendar?.spaceId ?? linkable.data?.find((ch) => ch.id === draft.channelId)?.spaceId,
                })
              }
              onRetry={(item) => void uploads.retry(item)}
              onRemove={uploads.remove}
            />
            {uploads.pending.some((p) => p.failed) ? (
              <Text variant="small" tone="danger">
                {t("calendar.filesFailed")}
              </Text>
            ) : null}
          </FormRow>
          <FormRow icon={FileText} tint={c.sky} align="start">
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
  start: { alignSelf: "flex-start" },
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
