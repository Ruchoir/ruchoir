/**
 * An event shared in a conversation (mockup 13): its day and title, a tap to its summary, and, for
 * someone invited, the answer: "Yes, I'll be there" or "No", then what was answered and a way to
 * change it. The answer shows at once and comes back if the server refuses it.
 */
import { getEvent, respondToEvent, type ApiMessage, type AttendeeStatus } from "@ruchoir/client";
import { useNavigation } from "@react-navigation/native";
import { CalendarDays, CalendarCheck, CalendarX, CircleHelp } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { Button } from "../../ui/Button";
import { Text } from "../../ui/Text";

type Answer = Exclude<AttendeeStatus, "needs_action">;

export function EventCardView({ message: m, myUserId }: { message: ApiMessage; myUserId?: string }) {
  const card = m.eventCard!;
  const navigation = useNavigation();
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const { locale, timeZone } = useLocale();
  const [status, setStatus] = useState<AttendeeStatus | undefined>(card.myStatus);
  const [changing, setChanging] = useState(false);
  const [failed, setFailed] = useState(false);
  const organizer = !!myUserId && card.organizerId === myUserId;

  // A card that just arrived carries nobody's answer: the reader's own is read from the event.
  useEffect(() => {
    if (!m.fresh || card.myStatus !== undefined || !myUserId || organizer) return;
    const abort = new AbortController();
    getEvent(card.eventId, abort.signal).then(
      (event) => setStatus(event.attendees.find((a) => a.userId === myUserId)?.status),
      () => {},
    );
    return () => abort.abort();
  }, [m.fresh, card.myStatus, card.eventId, myUserId, organizer]);

  const answer = (next: Answer) => {
    const before = status;
    setStatus(next);
    setChanging(false);
    setFailed(false);
    respondToEvent(card.eventId, next).catch(() => {
      setStatus(before);
      setFailed(true);
    });
  };

  const invited = status !== undefined && !organizer;
  const asking = invited && (status === "needs_action" || changing);
  const when = new Intl.DateTimeFormat(locale, {
    timeZone: card.allDay ? "UTC" : timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    ...(card.allDay ? {} : { hour: "2-digit", minute: "2-digit" }),
  }).format(new Date(card.start));
  const answered =
    status === "accepted"
      ? { icon: CalendarCheck, text: t("event.going"), color: s.success }
      : status === "declined"
        ? { icon: CalendarX, text: t("event.notGoing"), color: c.muted }
        : status === "tentative"
          ? { icon: CircleHelp, text: t("event.maybe"), color: c.muted }
          : null;

  return (
    <View style={styles.wrap}>
      <Pressable
        accessibilityRole="button"
        onPress={() => navigation.navigate("eventSummary", { eventId: card.eventId, recurrenceId: card.recurrenceId, start: card.start })}
        style={({ pressed }) => [styles.card, { borderColor: c.ink, backgroundColor: c.surface }, pressed && { opacity: 0.7 }]}
      >
        <View style={[styles.icon, { backgroundColor: c.sky }]}>
          <CalendarDays size={18} color={c.onPastel} />
        </View>
        <View style={styles.text}>
          <Text variant="smallStrong" numberOfLines={2}>
            {card.title}
          </Text>
          <Text variant="tiny" tone="muted">
            {when}
          </Text>
          {card.location ? (
            <Text variant="tiny" tone="muted" numberOfLines={1}>
              {card.location}
            </Text>
          ) : null}
        </View>
      </Pressable>
      {asking ? (
        <View style={styles.answers}>
          <Button size="sm" variant="secondary" label={t("event.yes")} onPress={() => answer("accepted")} />
          <Button size="sm" variant="ghost" label={t("event.no")} onPress={() => answer("declined")} />
          {card.recurring ? (
            <Text variant="tiny" tone="muted">
              {t("event.allDates")}
            </Text>
          ) : null}
        </View>
      ) : invited && answered ? (
        <View style={styles.answers}>
          <answered.icon size={16} color={answered.color} />
          <Text variant="smallStrong" style={{ color: answered.color }}>
            {answered.text}
          </Text>
          <Pressable accessibilityRole="button" hitSlop={10} onPress={() => setChanging(true)}>
            <Text variant="small" tone="link">
              {t("event.change")}
            </Text>
          </Pressable>
        </View>
      ) : null}
      {failed ? (
        <Text variant="tiny" tone="danger">
          {t("event.answerFailed")}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  card: { flexDirection: "row", alignItems: "center", gap: 10, padding: 10, borderRadius: radius.m, borderWidth: 2, maxWidth: 320 },
  icon: { width: 36, height: 36, borderRadius: radius.s, alignItems: "center", justifyContent: "center" },
  text: { flex: 1, minWidth: 0 },
  answers: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 },
});
