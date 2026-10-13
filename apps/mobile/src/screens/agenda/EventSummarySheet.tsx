import { fileDownloadUrl, getEvent, type AttendeeStatus } from "@ruchoir/client";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import { Clock, Download, MapPin, MessageSquare, Paperclip, Users, X } from "lucide-react-native";
import type { ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useLoad } from "../../data/useLoad";
import { key, useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { timeOf } from "../../logic/format";
import type { RootParams } from "../../navigation/types";
import { mix, radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { Avatar } from "../../ui/Avatar";
import { FileCard } from "../../ui/FileCard";
import { LoadState } from "../../ui/States";
import { Text } from "../../ui/Text";

const STATUS_TEXT: Record<AttendeeStatus, ReturnType<typeof key>> = {
  accepted: key("attendee.accepted"),
  tentative: key("attendee.tentative"),
  declined: key("attendee.declined"),
  needs_action: key("attendee.needsAction"),
};

/**
 * An event's summary (mockup 18): when, where, the channel it is shared in, who is invited and the
 * files it carries. Read-only in this step: no Edit and no Delete.
 */
export function EventSummarySheet() {
  const { params } = useRoute<RouteProp<RootParams, "eventSummary">>();
  const navigation = useNavigation();
  const { t } = useTranslation();
  const { c } = useTheme();
  const { locale, timeZone } = useLocale();
  const insets = useSafeAreaInsets();
  const event = useLoad(`event:${params.eventId}`, (signal) => getEvent(params.eventId, signal));
  const e = event.data;

  if (!e) {
    return (
      <View style={[styles.fill, { backgroundColor: c.surface }]}>
        <LoadState error={event.error} onRetry={event.reload} />
      </View>
    );
  }

  // A repeated event is fetched as its series; the occurrence opened is the one at `recurrenceId`.
  const length = Date.parse(e.end) - Date.parse(e.start);
  const start = params.recurrenceId ?? e.start;
  const end = params.recurrenceId ? new Date(Date.parse(params.recurrenceId) + length).toISOString() : e.end;
  const dateFormat = new Intl.DateTimeFormat(locale, {
    timeZone: e.allDay ? "UTC" : timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const date = dateFormat.format(new Date(e.allDay ? `${start.slice(0, 10)}T12:00:00Z` : start));
  const when = e.allDay ? t("agenda.allDay") : `${timeOf(start, locale, timeZone)} – ${timeOf(end, locale, timeZone)}`;
  const band = mix(c.sky, c.surface, 0.45);

  return (
    <ScrollView style={{ backgroundColor: c.surface }} contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
      <View style={[styles.band, { backgroundColor: band }]}>
        <Text variant="title" style={[styles.title, { color: c.onPastel }]}>
          {e.title}
        </Text>
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
        </Row>
        {e.location ? (
          <Row icon={<MapPin size={20} color={c.onPastel} />} tint={c.mint}>
            <Text variant="bodyStrong">{e.location}</Text>
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
            {e.attendees.map((a) => (
              <View key={a.id} style={styles.attendee}>
                <Avatar name={a.name} size={28} />
                <View style={styles.flex}>
                  <Text variant="small" numberOfLines={1}>
                    {a.name}
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
        {e.description ? (
          <Text tone="body" style={styles.description}>
            {e.description}
          </Text>
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
  close: { width: 40, height: 40, alignItems: "center", justifyContent: "center", marginTop: -6 },
  rows: { paddingHorizontal: 20 },
  row: { flexDirection: "row", gap: 14, paddingVertical: 14, borderBottomWidth: 1 },
  tile: { width: 32, height: 32, borderRadius: radius.s + 2, alignItems: "center", justifyContent: "center" },
  flex: { flex: 1, minWidth: 0, gap: 6 },
  attendee: { flexDirection: "row", alignItems: "center", gap: 10 },
  description: { paddingTop: 14 },
});
