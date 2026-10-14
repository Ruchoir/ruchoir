/**
 * An event shared in a conversation, drawn as the web draws it: a date tile (the month over the
 * day), the title, when and where, who organises it, and, for someone invited, their answer in three
 * buttons (for every date of a series). A tap opens its summary. The answer shows at once and comes
 * back if the server refuses it.
 */
import { getEvent, respondToEvent, type ApiMessage, type AttendeeStatus } from "@ruchoir/client";
import { useNavigation } from "@react-navigation/native";
import { Clock, MapPin, Repeat } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { timeOf } from "../../logic/format";
import { hairline, radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { feel } from "../../ui/haptics";
import { Text } from "../../ui/Text";
import { AnswerButtons, type Answer } from "../agenda/AnswerButtons";

export function EventCardView({ message: m, myUserId }: { message: ApiMessage; myUserId?: string }) {
  const card = m.eventCard!;
  const navigation = useNavigation();
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const { locale, timeZone } = useLocale();
  const [status, setStatus] = useState<AttendeeStatus | undefined>(card.myStatus);
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
    setFailed(false);
    respondToEvent(card.eventId, next).catch(() => {
      feel("failure");
      setStatus(before);
      setFailed(true);
    });
  };

  const invited = status !== undefined && !organizer;
  // The day of the tile and of the line: the event's own for a whole day, the reader's otherwise.
  const zone = card.allDay ? "UTC" : timeZone;
  const at = new Date(card.allDay ? `${card.start.slice(0, 10)}T12:00:00Z` : card.start);
  const month = new Intl.DateTimeFormat(locale, { timeZone: zone, month: "short" }).format(at).replace(".", "");
  const dayNumber = new Intl.DateTimeFormat(locale, { timeZone: zone, day: "numeric" }).format(at);
  const longDate = new Intl.DateTimeFormat(locale, { timeZone: zone, weekday: "long", day: "numeric", month: "long" }).format(at);
  const date = longDate.charAt(0).toLocaleUpperCase(locale) + longDate.slice(1);
  const when = card.allDay ? date : `${date}, ${timeOf(card.start, locale, timeZone)} – ${timeOf(card.end, locale, timeZone)}`;

  return (
    <View style={[styles.card, { borderColor: c.line, backgroundColor: c.surface }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${card.title}, ${when}`}
        onPress={() => navigation.navigate("eventSummary", { eventId: card.eventId, recurrenceId: card.recurrenceId, start: card.start })}
        style={({ pressed }) => [styles.head, pressed && { opacity: 0.7 }]}
      >
        <View style={[styles.tile, { borderColor: c.line, backgroundColor: s.sunken }]}>
          <Text variant="smallStrong" style={[styles.month, { backgroundColor: c.acc, color: c.onPastel }]}>
            {month.toLocaleUpperCase(locale)}
          </Text>
          <Text variant="heading" style={styles.dayNumber}>
            {dayNumber}
          </Text>
        </View>
        <View style={styles.text}>
          <Text variant="bodyStrong" numberOfLines={2}>
            {card.title}
          </Text>
          <View style={styles.meta}>
            <Clock size={13} color={c.body} />
            <Text variant="small" tone="body" style={styles.shrink}>
              {when}
            </Text>
            {card.recurring ? <Repeat size={13} color={c.body} /> : null}
          </View>
          {card.location ? (
            <View style={styles.meta}>
              <MapPin size={13} color={c.body} />
              <Text variant="small" tone="body" numberOfLines={1} style={styles.shrink}>
                {card.location}
              </Text>
            </View>
          ) : null}
          {card.organizer ? (
            <Text variant="tiny" tone="muted">
              {t("calendar.organizedBy", { name: organizer ? t("calendar.me") : card.organizer })}
            </Text>
          ) : null}
        </View>
      </Pressable>
      {invited ? (
        <View style={styles.answers}>
          <AnswerButtons value={status} onAnswer={answer} />
          {card.recurring ? (
            <Text variant="tiny" tone="muted">
              {t("event.allDates")}
            </Text>
          ) : null}
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
  // As wide as the column it sits in (a message, or under a notice), never wider than a phone's card.
  card: { alignSelf: "stretch", maxWidth: 420, gap: 10, padding: 12, borderRadius: radius.m, borderWidth: hairline },
  head: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  tile: { width: 48, borderRadius: radius.s, borderWidth: hairline, overflow: "hidden", alignItems: "center" },
  month: { alignSelf: "stretch", textAlign: "center", fontSize: 11, lineHeight: 15, paddingVertical: 1 },
  dayNumber: { paddingTop: 2, paddingBottom: 4 },
  text: { flex: 1, minWidth: 0, gap: 4 },
  meta: { flexDirection: "row", alignItems: "center", gap: 6 },
  shrink: { flexShrink: 1 },
  answers: { gap: 6 },
});
