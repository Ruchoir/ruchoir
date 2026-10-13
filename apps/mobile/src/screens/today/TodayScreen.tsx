import { useTranslation } from "../../i18n";
import { TabHeader } from "../../ui/TabHeader";
import { TabScreen } from "../../ui/TabScreen";

export function TodayScreen() {
  const { t } = useTranslation();
  return (
    <TabScreen>
      <TabHeader title={t("tabs.today")} />
    </TabScreen>
  );
}
