import { listOccurrences, type Calendar, type Occurrence } from "@ruchoir/client";
import { clashes } from "@ruchoir/client/calendarLogic";
import { AlertTriangle } from "lucide-react-native";
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";

import { useTranslation } from "../../../i18n";
import { useLocale } from "../../../i18n/useLocale";
import { draftSpan, type EventDraft } from "../../../logic/eventForm";
import { timeOf } from "../../../logic/format";
import { useSpace } from "../../../space/SpaceProvider";
import { mix, radius } from "../../../theme/tokens";
import { useTheme } from "../../../theme/useTheme";
import { Text } from "../../../ui/Text";
import { calendarLabel } from "../calendarLabel";

/**
 * A warning, never a refusal: what the event would overlap in every calendar the person sees, and
 * which of the people invited are busy then (told by the availability strip). Checked a moment after
 * the times stop moving.
 */
export function ClashLine({ draft, calendars, busyNames, eventId }: { draft: EventDraft; calendars: Calendar[]; busyNames: string[]; eventId?: string }) {
  const { t } = useTranslation();
  const { c } = useTheme();
  const { locale } = useLocale();
  const { spaces } = useSpace();
  const span = draftSpan(draft);
  const spanKey = span ? `${span.start}/${span.end}` : "";
  const ids = calendars.map((cal) => cal.id).join(",");
  // What was found, for the times and calendars it was asked for: nothing shows for others.
  const [result, setResult] = useState<{ key: string; found: Occurrence[] }>({ key: "", found: [] });
  const asked = `${spanKey}|${ids}`;
  const found = result.key === asked ? result.found : [];
  useEffect(() => {
    if (!spanKey || !ids) return;
    const [from, to] = spanKey.split("/");
    const abort = new AbortController();
    const wait = setTimeout(() => {
      listOccurrences(from, to, ids.split(","), abort.signal).then(
        (occurrences) => setResult({ key: `${spanKey}|${ids}`, found: clashes(occurrences, { start: from, end: to }, draft.tz, eventId) }),
        () => {},
      );
    }, 300);
    return () => {
      clearTimeout(wait);
      abort.abort();
    };
  }, [spanKey, ids, draft.tz, eventId]);

  if (found.length === 0 && busyNames.length === 0) return null;
  const where = (o: Occurrence) => {
    const cal = calendars.find((k) => k.id === o.calendarId);
    if (!cal) return "";
    const label = calendarLabel(cal, spaces.data ?? [], t("calendar.personal"));
    return [label.sub, label.main].filter(Boolean).join(" · ");
  };
  const when = (o: Occurrence) => (o.allDay ? t("agenda.allDay") : `${timeOf(o.start, locale, draft.tz)} - ${timeOf(o.end, locale, draft.tz)}`);
  return (
    <View style={[styles.box, { backgroundColor: mix(c.sun, c.surface, 0.3) }]} accessibilityRole="alert">
      <AlertTriangle size={16} color={c.ink} style={styles.icon} />
      <View style={styles.texts}>
        {found.length === 1 ? (
          <Text variant="small">{t("calendar.clash", { count: 1, title: found[0].title, where: where(found[0]), when: when(found[0]) })}</Text>
        ) : found.length > 1 ? (
          <Text variant="small">
            {t("calendar.clash", { count: found.length, titles: found.slice(0, 3).map((o) => o.title).join(", ") + (found.length > 3 ? ", …" : "") })}
          </Text>
        ) : null}
        {busyNames.length > 0 ? <Text variant="small">{t("calendar.busyPeople", { count: busyNames.length, names: busyNames.join(", ") })}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { flexDirection: "row", gap: 8, marginHorizontal: 16, marginTop: 10, padding: 10, borderRadius: radius.m },
  icon: { marginTop: 1 },
  texts: { flex: 1, gap: 2 },
});
