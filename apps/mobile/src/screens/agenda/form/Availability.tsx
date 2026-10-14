import { freeBusy, type BusyTimes } from "@ruchoir/client";
import { addDays, freeSlots, localDay, localMinutes, zonedTime } from "@ruchoir/client/calendarLogic";
import { Search } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { useTranslation } from "../../../i18n";
import { useLocale } from "../../../i18n/useLocale";
import { busyDuring, placeOnStrip, stripWindow } from "../../../logic/availability";
import { draftSpan, hhmm, type EventDraft } from "../../../logic/eventForm";
import { timeOf } from "../../../logic/format";
import { hairline, mix, radius } from "../../../theme/tokens";
import { useTheme } from "../../../theme/useTheme";
import { Button } from "../../../ui/Button";
import { Text } from "../../../ui/Text";
import { updateDraft } from "./draftStore";

/** The slot finder looks this far ahead, within these hours (the web's defaults). */
const SEARCH_DAYS = 14;
const DAY_START = 8;
const DAY_END = 19;

/**
 * Who is free on the event's day (the web's `AvailabilityStrip`): a line per person, the person
 * first, their busy times in grey, the event in the accent, overlaps in red; free/busy only, never
 * what. Tells the form who is busy during the event, and finds the next slots when everyone is free.
 */
export function Availability({
  formKey,
  draft,
  people,
  me,
  eventId,
  onBusy,
}: {
  formKey: string;
  draft: EventDraft;
  /** The person first, then the members invited. */
  people: { userId: string; name: string }[];
  me?: string;
  eventId?: string;
  /** The others busy during the event, whenever that changes. */
  onBusy: (names: string[]) => void;
}) {
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const { locale } = useLocale();
  const [busy, setBusy] = useState<BusyTimes[] | null>(null);
  // The slots found, for the people and times they were looked for: a change shows none.
  const [found, setFound] = useState<{ key: string; slots: { start: string; end: string }[] } | null>(null);
  const [finding, setFinding] = useState(false);
  const span = draftSpan(draft);
  const ids = people.map((p) => p.userId).join(",");
  const day = draft.startDay;
  const tz = draft.tz;
  useEffect(() => {
    if (!ids) return;
    const abort = new AbortController();
    const wait = setTimeout(() => {
      freeBusy(ids.split(","), zonedTime(day, 0, tz), zonedTime(addDays(day, 1), 0, tz), abort.signal, eventId).then(setBusy, () => {});
    }, 250);
    return () => {
      clearTimeout(wait);
      abort.abort();
    };
  }, [ids, day, tz, eventId]);
  const from = span ? Date.parse(span.start) : 0;
  const to = span ? Date.parse(span.end) : 0;
  const theirs = (userId: string) => busy?.find((b) => b.userId === userId)?.busy ?? [];
  const taken = (userId: string) => span !== null && busyDuring(theirs(userId), from, to);
  const busyNames = people.filter((p) => p.userId !== me && taken(p.userId)).map((p) => p.name);
  const namesKey = busyNames.join("\u0000");
  useEffect(() => {
    onBusy(namesKey ? namesKey.split("\u0000") : []);
    // `namesKey` stands for the list it was made from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [namesKey]);
  const asked = `${ids}|${from}|${to}`;
  const slots = found?.key === asked ? found.slots : null;

  if (!span) return null;
  const dayStart = Date.parse(zonedTime(day, 0, tz));
  const window = stripWindow(dayStart, from, to);
  const event = placeOnStrip(dayStart, from, to, window);
  const findSlot = async () => {
    setFinding(true);
    const now = new Date().toISOString();
    const until = new Date(Date.now() + SEARCH_DAYS * 86_400_000).toISOString();
    const length = Math.max(15, Math.round((to - from) / 60_000));
    try {
      const times = await freeBusy(ids.split(","), now, until, undefined, eventId);
      setFound({
        key: asked,
        slots: freeSlots(
          times.flatMap((p) => p.busy),
          { from: now, days: SEARCH_DAYS, duration: length, dayStart: DAY_START, dayEnd: DAY_END, weekends: true, tz, limit: 5 },
        ),
      });
    } catch {
      setFound({ key: asked, slots: [] });
    } finally {
      setFinding(false);
    }
  };
  const applySlot = (slot: { start: string; end: string }) => {
    updateDraft(formKey, (d) => ({
      ...d,
      startDay: localDay(slot.start, tz),
      startTime: hhmm(localMinutes(slot.start, tz)),
      endDay: localDay(slot.end, tz),
      endTime: hhmm(localMinutes(slot.end, tz)),
    }));
    setFound(null);
  };
  const slotLabel = (slot: { start: string }) => {
    const date = new Intl.DateTimeFormat(locale, { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(new Date(slot.start));
    return `${date} · ${timeOf(slot.start, locale, tz)}`;
  };
  return (
    <View style={styles.block} accessibilityLabel={t("calendar.availability")}>
      {people.map((person) => {
        const isTaken = taken(person.userId);
        return (
          <View key={person.userId} style={styles.line}>
            <Text variant="tiny" numberOfLines={1} tone={isTaken ? "danger" : "strong"} style={styles.name}>
              {person.name}
            </Text>
            <View
              accessible
              accessibilityRole="image"
              accessibilityLabel={isTaken ? t("calendar.busyDuring", { name: person.name }) : t("calendar.freeDuring", { name: person.name })}
              style={[styles.track, { backgroundColor: s.sunken, borderColor: c.line }]}
            >
              {theirs(person.userId).map((b) => {
                const a = Date.parse(b.start);
                const z = Date.parse(b.end);
                const place = placeOnStrip(dayStart, a, z, window);
                const clash = a < to && from < z;
                return (
                  <View
                    key={b.start}
                    style={[
                      styles.busy,
                      { left: `${place.left * 100}%`, width: `${place.width * 100}%`, backgroundColor: clash ? mix(c.alarm, s.sunken, 0.6) : mix(c.muted, s.sunken, 0.5) },
                    ]}
                  />
                );
              })}
              <View style={[styles.event, { left: `${event.left * 100}%`, width: `${event.width * 100}%`, borderColor: c.ink, backgroundColor: mix(c.acc, s.sunken, 0.45) }]} />
            </View>
          </View>
        );
      })}
      <View style={styles.slots}>
        <Button variant="secondary" size="sm" icon={<Search size={16} color={c.ink} />} label={t("calendar.findSlot")} busy={finding} onPress={() => void findSlot()} />
        {slots?.map((slot) => (
          <Pressable
            key={slot.start}
            accessibilityRole="button"
            onPress={() => applySlot(slot)}
            style={({ pressed }) => [styles.slot, { borderColor: c.line, backgroundColor: mix(c.acc, c.surface, 0.3) }, pressed && { opacity: 0.6 }]}
          >
            <Text variant="small">{slotLabel(slot)}</Text>
          </Pressable>
        ))}
        {slots && slots.length === 0 ? (
          <Text variant="tiny" tone="muted">
            {t("calendar.noSlot")}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: 6 },
  line: { flexDirection: "row", alignItems: "center", gap: 8 },
  name: { width: 72 },
  track: { flex: 1, height: 22, borderRadius: 6, borderWidth: 1, overflow: "hidden" },
  busy: { position: "absolute", top: 3, bottom: 3, borderRadius: 4 },
  event: { position: "absolute", top: 1, bottom: 1, borderRadius: 4, borderWidth: hairline },
  slots: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, paddingTop: 4 },
  slot: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.l, borderWidth: hairline },
});
