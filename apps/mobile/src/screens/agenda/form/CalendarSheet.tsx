import { listCalendars, type Calendar } from "@ruchoir/client";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import { CalendarDays, Check } from "lucide-react-native";
import { Fragment } from "react";
import { StyleSheet } from "react-native";

import { useLoad } from "../../../data/useLoad";
import { useReloadOn } from "../../../data/useReloadOn";
import { useTranslation } from "../../../i18n";
import type { RootParams } from "../../../navigation/types";
import { useSpace } from "../../../space/SpaceProvider";
import { useTheme } from "../../../theme/useTheme";
import { ActionRow } from "../../../ui/ActionRow";
import { Sheet } from "../../../ui/Sheet";
import { LoadState } from "../../../ui/States";
import { Text } from "../../../ui/Text";
import { calendarColor } from "../calendarColor";
import { calendarLabel } from "../calendarLabel";
import { updateDraft, useDraft } from "./draftStore";

/**
 * Which calendar the event goes in, in the web's order: the person's own, those shared with them,
 * the current space's, then the other spaces'. Each in its colour, the one chosen ticked.
 */
export function CalendarSheet() {
  const { params } = useRoute<RouteProp<RootParams, "eventCalendar">>();
  const navigation = useNavigation();
  const { t } = useTranslation();
  const { c } = useTheme();
  const { spaces, current } = useSpace();
  const draft = useDraft(params.formKey);
  const calendars = useLoad("calendars", (signal) => listCalendars(signal));
  useReloadOn((e) => e.type === "calendar", calendars.reload);
  const spaceList = spaces.data ?? [];
  const writable = (calendars.data ?? []).filter((cal) => cal.canWriteEvents);
  const ofSpace = (id: string) => writable.filter((cal) => cal.spaceId === id);
  const others = spaceList
    .filter((s) => s.id !== current?.id)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const groups: { key: string; title: string; items: Calendar[] }[] = [
    { key: "mine", title: t("calendar.mine"), items: writable.filter((cal) => !cal.spaceId && !cal.shareLevel) },
    { key: "shared", title: t("files.sharedWithMe"), items: writable.filter((cal) => cal.shareLevel) },
    ...(current ? [{ key: current.id, title: current.name, items: ofSpace(current.id) }] : []),
    { key: "others", title: current ? t("calendar.otherSpaces") : t("calendar.mySpaces"), items: others.flatMap((s) => ofSpace(s.id)) },
  ].filter((g) => g.items.length > 0);
  return (
    <Sheet>
      <Text variant="heading">{t("eventForm.chooseCalendar")}</Text>
      {!calendars.data ? <LoadState error={calendars.error} onRetry={calendars.reload} /> : null}
      {groups.map((group) => (
        <Fragment key={group.key}>
          <Text variant="smallStrong" tone="muted" style={styles.group}>
            {group.title}
          </Text>
          {group.items.map((cal) => {
            const label = calendarLabel(cal, spaceList, t("calendar.personal"));
            return (
              <ActionRow
                key={cal.id}
                icon={CalendarDays}
                tint={calendarColor(cal.color, c)}
                title={label.main}
                subtitle={label.sub}
                selected={cal.id === draft?.calendarId}
                trailing={cal.id === draft?.calendarId ? <Check size={20} color={c.ink} /> : undefined}
                onPress={() => {
                  updateDraft(params.formKey, (d) => ({ ...d, calendarId: cal.id }));
                  navigation.goBack();
                }}
              />
            );
          })}
        </Fragment>
      ))}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  group: { marginTop: 10 },
});
