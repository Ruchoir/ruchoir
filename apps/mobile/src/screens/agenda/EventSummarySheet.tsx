import { deleteEvent, fileDownloadUrl, type AttendeeStatus, type EditScope } from "@ruchoir/client";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Clock, Download, MapPin, MessageSquare, Paperclip, SquarePen, Trash2, Users, X } from "lucide-react-native";
import type { ReactNode } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useLoad } from "../../data/useLoad";
import { useReloadOn } from "../../data/useReloadOn";
import { key, useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { timeOf } from "../../logic/format";
import type { RootParams } from "../../navigation/types";
import { hairline, mix, radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { ActionRow } from "../../ui/ActionRow";
import { Avatar } from "../../ui/Avatar";
import { FileCard } from "../../ui/FileCard";
import { LoadState } from "../../ui/States";
import { Text } from "../../ui/Text";
import { useToast } from "../../ui/Toast";
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
 * files it carries, for the date opened (a date of a series changed apart shows its own). Who may
 * change the event gets "Edit" and "Delete"; a date of a series asks which dates they are for.
 */
export function EventSummarySheet() {
  const { params } = useRoute<RouteProp<RootParams, "eventSummary">>();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const { t } = useTranslation();
  const { c } = useTheme();
  const { locale, timeZone } = useLocale();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const loaded = useLoad(`event:${params.eventId}:${params.recurrenceId ?? ""}`, (signal) =>
    loadOccurrence(params.eventId, params.recurrenceId, params.start, signal),
  );
  useReloadOn((e) => e.type === "calendar", loaded.reload);
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
  const band = mix(c.sky, c.surface, 0.45);
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
        </Row>
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
        {o.description ? (
          <Text tone="body" style={styles.description}>
            {o.description}
          </Text>
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
});
