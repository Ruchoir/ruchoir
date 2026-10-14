import { deleteEvent, fileDownloadUrl, listCalendars, respondToEvent, type AttendeeStatus, type EditScope } from "@ruchoir/client";
import { localDay, parseRule, remindersLabel, rulePhrase } from "@ruchoir/client/calendarLogic";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Bell, CalendarDays, ChevronRight, Clock, Download, MapPin, MessageSquare, Paperclip, SquarePen, Trash2, Users, X } from "lucide-react-native";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useLoad } from "../../data/useLoad";
import { useReloadOn } from "../../data/useReloadOn";
import { key, useTranslation } from "../../i18n";
import { useSharedT } from "../../i18n/sharedT";
import { useLocale } from "../../i18n/useLocale";
import { timeOf } from "../../logic/format";
import type { RootParams } from "../../navigation/types";
import { useSession } from "../../session/SessionProvider";
import { useSpace } from "../../space/SpaceProvider";
import { hairline, mix, radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { ActionRow } from "../../ui/ActionRow";
import { Avatar } from "../../ui/Avatar";
import { FileCard } from "../../ui/FileCard";
import { LoadState } from "../../ui/States";
import { Segmented } from "../../ui/Segmented";
import { Text } from "../../ui/Text";
import { useToast } from "../../ui/Toast";
import { AnswerButtons, type Answer } from "./AnswerButtons";
import { calendarColor } from "./calendarColor";
import { calendarLabel } from "./calendarLabel";
import { inheritedReminders } from "./form/RemindersSheet";
import { useScopeRequests } from "./form/scope";
import { loadOccurrence } from "./loadOccurrence";

const STATUS_TEXT: Record<AttendeeStatus, ReturnType<typeof key>> = {
  accepted: key("attendee.accepted"),
  tentative: key("attendee.tentative"),
  declined: key("attendee.declined"),
  needs_action: key("attendee.needsAction"),
};

/**
 * An event's summary (mockup 18): when, where, the channel it is shared in, who is invited and the
 * files it carries, for the date opened (a date of a series changed apart shows its own), how it
 * repeats and in which calendar. Someone invited answers here, for the series or this date alone;
 * anyone who sees it sets their own reminder. Who may change the event gets "Edit" and "Delete"; a
 * date of a series asks which dates they are for.
 */
export function EventSummarySheet() {
  const { params } = useRoute<RouteProp<RootParams, "eventSummary">>();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const { locale, timeZone } = useLocale();
  const say = useSharedT();
  const toast = useToast();
  const { spaces } = useSpace();
  const { state } = useSession();
  const me = state.kind === "signedIn" ? state.user : null;
  const calendars = useLoad("calendars", (signal) => listCalendars(signal));
  // The answer as just given, until the event read back says it; and for which dates.
  const [answered, setAnswered] = useState<AttendeeStatus | undefined>(undefined);
  const [onlyThisDate, setOnlyThisDate] = useState(false);
  const insets = useSafeAreaInsets();
  const loaded = useLoad(`event:${params.eventId}:${params.recurrenceId ?? ""}`, (signal) =>
    loadOccurrence(params.eventId, params.recurrenceId, params.start, signal),
  );
  const reloadEvent = loaded.reload;
  useReloadOn((e) => e.type === "calendar", reloadEvent);
  // Back from a sheet over it (one's own reminders): read the event again.
  const left = useRef(false);
  useEffect(() => {
    const blur = navigation.addListener("blur", () => {
      left.current = true;
    });
    const focus = navigation.addListener("focus", () => {
      if (left.current) reloadEvent();
      left.current = false;
    });
    return () => {
      blur();
      focus();
    };
  }, [navigation, reloadEvent]);
  const deleteKey = `delete:${params.eventId}`;

  const remove = async (scope: EditScope) => {
    try {
      await deleteEvent(params.eventId, scope, params.recurrenceId);
      navigation.goBack();
      toast(t("eventForm.deleted"));
    } catch {
      toast(t("eventForm.deleteFailed"));
    }
  };
  useScopeRequests(deleteKey, (scope) => void remove(scope));

  if (!loaded.data) {
    return (
      <View style={[styles.fill, { backgroundColor: c.surface }]}>
        <LoadState error={loaded.error} onRetry={loaded.reload} />
      </View>
    );
  }
  const { event: e, occurrence: o } = loaded.data;
  const seriesDate = e.isRecurring && !!o.recurrenceId;
  const calendar = calendars.data?.find((cal) => cal.id === o.calendarId);
  const label = calendar ? calendarLabel(calendar, spaces.data ?? []) : null;
  const form = e.rrule ? parseRule(e.rrule) : null;
  const repeats = e.rrule
    ? form
      ? rulePhrase(form, e.allDay ? e.start : localDay(e.start, e.tzid ?? timeZone), locale, say)
      : t("calendar.importedRule")
    : null;
  const isOrganizer = !!me && e.organizer?.userId === me.id;
  const onList = !!me && e.attendees.some((a) => a.userId === me.id);
  const myStatus = answered ?? o.myStatus;
  const answer = (next: Answer) => {
    setAnswered(next);
    respondToEvent(o.eventId, next, seriesDate && onlyThisDate ? o.recurrenceId : undefined).then(
      () => loaded.reload(),
      () => {
        setAnswered(undefined);
        toast(t("event.answerFailed"));
      },
    );
  };
  const counts = e.attendees.reduce((acc, a) => ({ ...acc, [a.status]: (acc[a.status] ?? 0) + 1 }), {} as Partial<Record<AttendeeStatus, number>>);
  const tally = [
    counts.accepted ? t("calendar.countAccepted", { count: counts.accepted }) : null,
    counts.tentative ? t("calendar.countTentative", { count: counts.tentative }) : null,
    counts.declined ? t("calendar.countDeclined", { count: counts.declined }) : null,
    counts.needs_action ? t("calendar.countWaiting", { count: counts.needs_action }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  // Someone else's calendar reminds its owner, not its readers, unless they are invited.
  const ownReminder = !(calendar?.shareLevel && !o.invited);
  const askDelete = () => {
    if (seriesDate) {
      navigation.navigate("eventScope", { key: deleteKey, title: o.title, action: "delete" });
      return;
    }
    Alert.alert(t("calendar.deleteConfirm", { title: o.title }), undefined, [
      { text: t("compose.cancel"), style: "cancel" },
      { text: t("compose.delete"), style: "destructive", onPress: () => void remove("all") },
    ]);
  };
  const dateFormat = new Intl.DateTimeFormat(locale, {
    timeZone: o.allDay ? "UTC" : timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const date = dateFormat.format(new Date(o.allDay ? `${o.start.slice(0, 10)}T12:00:00Z` : o.start));
  const when = o.allDay ? t("agenda.allDay") : `${timeOf(o.start, locale, timeZone)} – ${timeOf(o.end, locale, timeZone)}`;
  const band = mix(calendarColor(calendar?.color, c), c.surface, 0.45);
  return (
    <ScrollView style={{ backgroundColor: c.surface }} contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
      <View style={[styles.band, { backgroundColor: band }]}>
        <Text variant="title" style={[styles.title, { color: c.onPastel }]}>
          {o.title}
        </Text>
        {o.canEdit ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => navigation.navigate("eventForm", { eventId: o.eventId, recurrenceId: o.recurrenceId, start: o.start })}
            style={({ pressed }) => [styles.edit, { borderColor: c.onPastel, backgroundColor: c.surface }, pressed && { opacity: 0.6 }]}
          >
            <SquarePen size={16} color={c.ink} />
            <Text variant="smallStrong">{t("message.edit")}</Text>
          </Pressable>
        ) : null}
        <Pressable accessibilityRole="button" accessibilityLabel={t("common.close")} onPress={() => navigation.goBack()} style={styles.close}>
          <X size={22} color={c.onPastel} />
        </Pressable>
      </View>
      <View style={styles.rows}>
        <Row icon={<Clock size={20} color={c.onPastel} />} tint={c.violet}>
          <Text variant="bodyStrong">{date.charAt(0).toLocaleUpperCase(locale) + date.slice(1)}</Text>
          <Text variant="small" tone="muted">
            {when}
          </Text>
          {repeats ? (
            <Text variant="small" tone="muted">
              {repeats}
            </Text>
          ) : null}
          {!o.allDay && o.tzid && o.tzid !== timeZone ? (
            <Text variant="tiny" tone="muted">
              {o.tzid.replace(/_/g, " ")}
            </Text>
          ) : null}
        </Row>
        {calendar && label ? (
          <Row icon={<CalendarDays size={20} color={c.onPastel} />} tint={calendarColor(calendar.color, c)}>
            <Text variant="bodyStrong">{label.main}</Text>
            {label.sub ? (
              <Text variant="small" tone="muted">
                {label.sub}
              </Text>
            ) : null}
          </Row>
        ) : null}
        {o.location ? (
          <Row icon={<MapPin size={20} color={c.onPastel} />} tint={c.mint}>
            <Text variant="bodyStrong">{o.location}</Text>
          </Row>
        ) : null}
        {e.channel?.accessible && e.channel.name ? (
          <Row icon={<MessageSquare size={20} color={c.onPastel} />} tint={c.pink}>
            <Text variant="tiny" tone="muted">
              {t("event.sharedIn")}
            </Text>
            <Text variant="bodyStrong">{e.channel.name}</Text>
          </Row>
        ) : null}
        {e.attendees.length ? (
          <Row icon={<Users size={20} color={c.onPastel} />} tint={c.sun}>
            <Text variant="bodyStrong">{t("event.invited", { count: e.attendees.length })}</Text>
            {tally ? (
              <Text variant="small" tone="muted">
                {tally}
              </Text>
            ) : null}
            {e.organizer ? (
              <Text variant="small" tone="muted">
                {t("calendar.organizedBy", { name: e.organizer.userId === me?.id ? t("calendar.me") : e.organizer.name })}
              </Text>
            ) : null}
            {e.attendees.map((a) => (
              <View key={a.id} style={styles.attendee}>
                <Avatar name={a.name} size={28} />
                <View style={styles.flex}>
                  <Text variant="small" numberOfLines={1}>
                    {a.userId && a.userId === me?.id ? t("calendar.me") : a.name}
                  </Text>
                  <Text variant="tiny" tone="muted">
                    {t(STATUS_TEXT[a.status])}
                  </Text>
                </View>
              </View>
            ))}
          </Row>
        ) : null}
        {e.files.length ? (
          <Row icon={<Paperclip size={20} color={c.onPastel} />} tint={c.peach}>
            <Text variant="bodyStrong">{t("event.files")}</Text>
            {e.files.map((f) => (
              <FileCard
                key={f.id}
                name={f.name}
                sizeBytes={f.size}
                trailing={<Download size={18} color={c.body} />}
                onPress={() => navigation.navigate("fileViewer", { file: { id: f.id, name: f.name, url: fileDownloadUrl(f.id), sizeBytes: f.size } })}
              />
            ))}
          </Row>
        ) : null}
        {o.description ? (
          <Text tone="body" style={styles.description}>
            {o.description}
          </Text>
        ) : null}
        {onList && !isOrganizer ? (
          <View style={[styles.answer, { backgroundColor: s.sunken }]} accessibilityLabel={t("calendar.yourAnswer")}>
            <Text variant="smallStrong">{t("calendar.yourAnswer")}</Text>
            {seriesDate ? (
              <Segmented
                options={[
                  { key: "series", label: t("event.allDates") },
                  { key: "date", label: t("calendar.answerThisDate") },
                ]}
                value={onlyThisDate ? "date" : "series"}
                onChange={(v) => setOnlyThisDate(v === "date")}
                style={styles.flush}
              />
            ) : null}
            <AnswerButtons value={myStatus} onAnswer={answer} />
          </View>
        ) : null}
        {ownReminder ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => navigation.navigate("eventReminders", { eventId: o.eventId })}
            style={({ pressed }) => [styles.row, { borderBottomColor: c.line }, pressed && { opacity: 0.6 }]}
          >
            <View style={[styles.tile, { backgroundColor: c.pink }]}>
              <Bell size={20} color={c.onPastel} />
            </View>
            <View style={styles.flex}>
              <Text variant="tiny" tone="muted">
                {t("calendar.myReminder")}
              </Text>
              <Text variant="body">
                {e.myOwnReminders === undefined
                  ? t("calendar.reminderFollowsCalendar", { label: remindersLabel(inheritedReminders(calendar, o.allDay), say, o.allDay) })
                  : remindersLabel(e.myOwnReminders, say, o.allDay)}
              </Text>
            </View>
            <ChevronRight size={18} color={c.muted} style={styles.chevron} />
          </Pressable>
        ) : null}
        {o.canEdit ? (
          <View style={[styles.danger, { borderTopColor: c.line }]}>
            <ActionRow icon={Trash2} danger title={t("eventForm.deleteEvent")} onPress={askDelete} />
          </View>
        ) : null}
      </View>
    </ScrollView>
  );
}

function Row({ icon, tint, children }: { icon: ReactNode; tint: string; children: ReactNode }) {
  const { c } = useTheme();
  return (
    <View style={[styles.row, { borderBottomColor: c.line }]}>
      <View style={[styles.tile, { backgroundColor: tint }]}>{icon}</View>
      <View style={styles.flex}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  band: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingHorizontal: 20, paddingTop: 28, paddingBottom: 18 },
  title: { flex: 1, fontSize: 22, lineHeight: 28 },
  edit: { flexDirection: "row", alignItems: "center", gap: 6, height: 36, paddingHorizontal: 12, borderRadius: radius.m, borderWidth: hairline, marginTop: -4 },
  close: { width: 40, height: 40, alignItems: "center", justifyContent: "center", marginTop: -6 },
  rows: { paddingHorizontal: 20 },
  row: { flexDirection: "row", gap: 14, paddingVertical: 14, borderBottomWidth: 1 },
  tile: { width: 32, height: 32, borderRadius: radius.s + 2, alignItems: "center", justifyContent: "center" },
  flex: { flex: 1, minWidth: 0, gap: 6 },
  attendee: { flexDirection: "row", alignItems: "center", gap: 10 },
  description: { paddingTop: 14 },
  danger: { marginTop: 18, paddingTop: 10, borderTopWidth: hairline },
  answer: { gap: 10, marginTop: 14, padding: 12, borderRadius: radius.m },
  flush: { marginHorizontal: 0 },
  chevron: { alignSelf: "center" },
});
