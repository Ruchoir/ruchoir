import { CalendarDays } from "lucide-react-native";
import { View } from "react-native";

import { useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { groupByDay } from "../../logic/agenda";
import { EmptyState } from "../../ui/States";
import type { AgendaData } from "./AgendaScreen";
import { DayEvents } from "./DayEvents";

/** What is coming, day by day, from today (mockup 15). */
export function ListView({ data, today }: { data: AgendaData; today: string }) {
  const { t } = useTranslation();
  const { timeZone } = useLocale();
  const days = groupByDay(data.occurrences, timeZone).filter((d) => d.day >= today);
  if (days.length === 0) return <EmptyState icon={CalendarDays} title={t("agenda.nothingSoon")} text={t("agenda.nothingSoonHint")} />;
  return (
    <View style={{ gap: 18 }}>
      {days.map((d) => (
        <DayEvents key={d.day} day={d.day} today={today} items={d.items} data={data} />
      ))}
    </View>
  );
}
