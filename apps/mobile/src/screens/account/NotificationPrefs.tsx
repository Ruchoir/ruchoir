import DateTimePicker, { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import { getNotificationPreferences, saveNotificationPreferences, type NotificationPreferences } from "@ruchoir/client";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useState } from "react";
import { Alert, Linking, Platform, Pressable, StyleSheet, View } from "react-native";

import { useLoad } from "../../data/useLoad";
import { key, useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { disablePhonePush, enablePhonePush, phonePushState, type PhonePush } from "../../push/phone";
import { radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { LoadState } from "../../ui/States";
import { Text } from "../../ui/Text";
import { useToast } from "../../ui/Toast";
import { Section } from "./Section";
import { ToggleRow } from "./ToggleRow";

type Flag = { [K in keyof NotificationPreferences]: NotificationPreferences[K] extends boolean ? K : never }[keyof NotificationPreferences];

/** The kinds, each with its switch in the app and its switch by e-mail, as the web's table lists them. */
const KINDS: { title: ReturnType<typeof key>; text: ReturnType<typeof key>; app: Flag; email?: Flag }[] = [
  { title: key("notifPrefs.mentions"), text: key("notifPrefs.mentionsText"), app: "mentions", email: "emailMentions" },
  { title: key("notifPrefs.broadcasts"), text: key("notifPrefs.broadcastsText"), app: "channelMentions", email: "emailBroadcasts" },
  { title: key("notifPrefs.replies"), text: key("notifPrefs.repliesText"), app: "replies", email: "emailReplies" },
  { title: key("sidebar.directMessages"), text: key("notifPrefs.directText"), app: "directMessages", email: "emailDirectMessages" },
  // In the app and on the phone only: neither is ever worth an e-mail.
  { title: key("notifPrefs.reactions"), text: key("notifPrefs.reactionsText"), app: "reactions" },
  { title: key("notifPrefs.edits"), text: key("notifPrefs.editsText"), app: "edits" },
  { title: key("details.levelAllHint"), text: key("notifPrefs.messagesText"), app: "messages", email: "emailMessages" },
  { title: key("notifPrefs.reminders"), text: key("notifPrefs.remindersText"), app: "calendarReminders", email: "emailCalendarReminders" },
  { title: key("notifPrefs.invitations"), text: key("notifPrefs.invitationsText"), app: "calendarInvitations", email: "emailCalendarInvitations" },
];

/** `"22:00"` as a date the time picker shows, and back. */
const asDate = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(2026, 0, 1, h || 0, m || 0);
};
const asTime = (date: Date) => `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;

/**
 * Whether this phone receives notifications (ADR 0006): turning it on asks the system, then registers
 * the phone with the instance; off forgets it there. Refused in the phone's settings, the switch
 * leads there. Expo Go cannot receive them.
 */
function PhonePushRow() {
  const { t } = useTranslation();
  const toast = useToast();
  const [state, setState] = useState<PhonePush | null>(null);
  const [busy, setBusy] = useState(false);
  // Read again on coming back, the phone's settings having perhaps been changed meanwhile.
  useFocusEffect(
    useCallback(() => {
      void phonePushState().then(setState);
    }, []),
  );
  if (state === null) return null;
  if (state === "unavailable") return <ToggleRow title={t("push.thisPhone")} text={t("push.unavailable")} value={false} disabled onChange={() => {}} />;

  const change = async (on: boolean) => {
    setBusy(true);
    try {
      if (!on) {
        await disablePhonePush();
        setState("off");
        return;
      }
      const next = await enablePhonePush(true);
      setState(next);
      if (next === "denied") {
        Alert.alert(t("push.deniedTitle"), t("push.deniedText"), [
          { text: t("compose.cancel"), style: "cancel" },
          { text: t("attach.openSettings"), onPress: () => void Linking.openSettings() },
        ]);
      }
    } catch {
      toast(t("push.failed"), "failure");
    } finally {
      setBusy(false);
    }
  };

  return (
    <ToggleRow
      title={t("push.thisPhone")}
      text={state === "denied" ? t("push.deniedText") : t("push.thisPhoneText")}
      value={state === "on"}
      disabled={busy}
      onChange={(on) => void change(on)}
    />
  );
}

/**
 * The account's notifications, the same settings as the web's (the server acts on them for every
 * device): which kinds reach the person in the app and by e-mail, and the quiet hours. Each switch is
 * saved at once and put back if the server refuses it. First, whether this phone receives them.
 */
export function NotificationPrefs() {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const toast = useToast();
  const loaded = useLoad("notificationPrefs", (signal) => getNotificationPreferences(signal));
  const [changed, setChanged] = useState<NotificationPreferences | null>(null);
  const prefs = changed ?? loaded.data;

  const save = (patch: Partial<NotificationPreferences>) => {
    if (!prefs) return;
    const before = prefs;
    // Quiet hours are read in this phone's clock.
    const next = { ...prefs, ...patch, utcOffsetMinutes: -new Date().getTimezoneOffset() };
    setChanged(next);
    saveNotificationPreferences(next).catch(() => {
      setChanged(before);
      toast(t("details.saveFailed"), "failure");
    });
  };

  if (!prefs) {
    return (
      <Section label={t("details.notifications")}>
        <LoadState error={loaded.error} onRetry={loaded.reload} />
      </Section>
    );
  }
  const off = !prefs.enabled;

  return (
    <>
      <Section label={t("push.section")}>
        <PhonePushRow />
      </Section>
      <Section label={t("details.notifications")}>
        <ToggleRow title={t("notifPrefs.enabled")} text={t("notifPrefs.enabledText")} value={prefs.enabled} onChange={(enabled) => save({ enabled })} />
        {KINDS.map((kind) => (
          <ToggleRow
            key={kind.app}
            title={t(kind.title)}
            text={t(kind.text)}
            value={prefs[kind.app]}
            onChange={(value) => save({ [kind.app]: value })}
            disabled={off}
          />
        ))}
      </Section>
      <Section label={t("notifPrefs.quiet")}>
        <ToggleRow
          title={t("notifPrefs.quietHours")}
          text={t("notifPrefs.quietText")}
          value={prefs.quietHours}
          onChange={(quietHours) => save({ quietHours })}
          disabled={off}
        />
        {prefs.quietHours && !off ? (
          <View style={styles.times}>
            <TimeField label={t("eventForm.start")} value={prefs.quietFrom} locale={locale} onChange={(quietFrom) => save({ quietFrom })} />
            <TimeField label={t("eventForm.end")} value={prefs.quietTo} locale={locale} onChange={(quietTo) => save({ quietTo })} />
          </View>
        ) : null}
      </Section>
      <Section label={t("notifPrefs.byEmail")}>
        <ToggleRow title={t("notifPrefs.email")} text={t("notifPrefs.emailText")} value={prefs.email} onChange={(email) => save({ email })} />
        {KINDS.map(({ title, email }) =>
          email ? (
            <ToggleRow key={email} title={t(title)} value={prefs[email]} onChange={(value) => save({ [email]: value })} disabled={!prefs.email} />
          ) : null,
        )}
      </Section>
    </>
  );
}

/** A time of day from the phone's own picker: inline on iOS, the system dialog on Android. */
function TimeField({ label, value, locale, onChange }: { label: string; value: string; locale: string; onChange: (hhmm: string) => void }) {
  const { c, s, dark } = useTheme();
  const shown = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(asDate(value));
  return (
    <View style={styles.time}>
      <Text variant="small" tone="muted">
        {label}
      </Text>
      {Platform.OS === "ios" ? (
        <DateTimePicker
          value={asDate(value)}
          mode="time"
          display="compact"
          locale={locale}
          themeVariant={dark ? "dark" : "light"}
          onChange={(event, date) => {
            if (event.type === "set" && date) onChange(asTime(date));
          }}
        />
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${label} ${shown}`}
          onPress={() =>
            DateTimePickerAndroid.open({
              value: asDate(value),
              mode: "time",
              onChange: (event, date) => {
                if (event.type === "set" && date) onChange(asTime(date));
              },
            })
          }
          style={[styles.timeButton, { backgroundColor: s.sunken, borderColor: c.line }]}
        >
          <Text variant="bodyStrong">{shown}</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  times: { flexDirection: "row", gap: 16, paddingBottom: 4 },
  time: { flex: 1, gap: 6, alignItems: "flex-start" },
  timeButton: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.m, borderWidth: 1 },
});
