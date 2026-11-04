/**
 * The space calendars the person manages, to open the sharing of one (the Agenda's head): each in its
 * colour, a tap opens who has access and at what level. Personal calendars are shared another way.
 */
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { CalendarDays, Users } from "lucide-react-native";
import { StyleSheet } from "react-native";

import { useApi } from "../../api/useApi";
import { useLoad } from "../../data/useLoad";
import { useReloadOn } from "../../data/useReloadOn";
import { useTranslation } from "../../i18n";
import type { RootParams } from "../../navigation/types";
import { useSpace } from "../../space/SpaceProvider";
import { useTheme } from "../../theme/useTheme";
import { ActionRow } from "../../ui/ActionRow";
import { Sheet } from "../../ui/Sheet";
import { EmptyState, LoadState } from "../../ui/States";
import { Text } from "../../ui/Text";
import { calendarColor } from "../agenda/calendarColor";
import { calendarName } from "../agenda/calendarLabel";

export function CalendarsSheet() {
  const { listCalendars } = useApi();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const { t } = useTranslation();
  const { c } = useTheme();
  const { current } = useSpace();
  const calendars = useLoad("calendars", (signal) => listCalendars(signal));
  useReloadOn((e) => e.type === "calendar", calendars.reload);
  const mine = (calendars.data ?? []).filter((cal) => cal.spaceId === current?.id && cal.canManage);
  return (
    <Sheet>
      <Text variant="heading">{t("access.calendarsTitle")}</Text>
      {!calendars.data ? <LoadState error={calendars.error} onRetry={calendars.reload} /> : null}
      {calendars.data && mine.length === 0 ? <EmptyState size="compact" icon={Users} title={t("access.calendarsEmpty")} text={t("access.calendarsEmptyHint")} /> : null}
      {mine.length > 0 ? (
        <Text variant="small" tone="muted" style={styles.hint}>
          {t("access.calendarsHint")}
        </Text>
      ) : null}
      {mine.map((cal) => (
        <ActionRow
          key={cal.id}
          icon={CalendarDays}
          tint={calendarColor(cal.color, c)}
          title={calendarName(cal, t("calendar.personal"))}
          onPress={() => navigation.replace("access", { kind: "calendar", resourceId: cal.id, title: cal.name })}
        />
      ))}
    </Sheet>
  );
}

const styles = StyleSheet.create({ hint: { marginBottom: 6 } });
