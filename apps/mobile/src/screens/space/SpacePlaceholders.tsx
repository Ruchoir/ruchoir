/**
 * The sections of a space's settings whose screens come in later steps (groups). Their rows are
 * not listed until `READY` (`logic/spaceSections.ts`) says so; the screens exist so the routes do,
 * and say so plainly if one is reached.
 */
import { Users, type LucideIcon } from "lucide-react-native";
import { StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useTranslation } from "../../i18n";
import type { SectionKey } from "../../logic/spaceSections";
import { useSectionGuard } from "../../space/rights";
import { useSpace } from "../../space/SpaceProvider";
import { useTheme } from "../../theme/useTheme";
import { BackHeader } from "../../ui/BackHeader";
import { EmptyState } from "../../ui/States";

function Placeholder({ section, icon }: { section: SectionKey; icon: LucideIcon }) {
  const { t } = useTranslation();
  const { c } = useTheme();
  const { current } = useSpace();
  useSectionGuard(section);
  return (
    <SafeAreaView edges={["top"]} style={[styles.fill, { backgroundColor: c.bg }]}>
      <BackHeader title={t(`spaceSections.${section}` as never)} subtitle={current?.name} />
      <EmptyState icon={icon} title={t("spaceSections.soonTitle")} text={t("spaceSections.soonText")} />
    </SafeAreaView>
  );
}

export const SpaceGroupsScreen = () => <Placeholder section="groups" icon={Users} />;

const styles = StyleSheet.create({ fill: { flex: 1 } });
