import { Users } from "lucide-react-native";

import { useTranslation } from "../i18n";
import { EmptyState } from "./States";
import { TabHeader } from "./TabHeader";
import { TabScreen } from "./TabScreen";

/** A tab for someone in no space yet: its title, and how to get into one (from the web, for now). */
export function NoSpace({ title }: { title: string }) {
  const { t } = useTranslation();
  return (
    <TabScreen>
      <TabHeader title={title} />
      <EmptyState icon={Users} title={t("spaces.none")} text={t("spaces.noneHint")} />
    </TabScreen>
  );
}
