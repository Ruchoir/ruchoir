/**
 * A role's editor (frames 5 and 6). The roles list opens it already; its tabs, toggles and preview
 * arrive with the next step, so for now it names the role and says so.
 */
import { useRoute, type RouteProp } from "@react-navigation/native";
import { Shield } from "lucide-react-native";
import { StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useTranslation } from "../../i18n";
import type { RootParams } from "../../navigation/types";
import { useSpace } from "../../space/SpaceProvider";
import { useTheme } from "../../theme/useTheme";
import { BackHeader } from "../../ui/BackHeader";
import { EmptyState } from "../../ui/States";

export function RoleEditorScreen() {
  const { t } = useTranslation();
  const { c } = useTheme();
  const { current } = useSpace();
  useRoute<RouteProp<RootParams, "roleEditor">>();
  return (
    <SafeAreaView edges={["top"]} style={[styles.fill, { backgroundColor: c.bg }]}>
      <BackHeader title={t("spaceSections.roles")} subtitle={current?.name} />
      <EmptyState icon={Shield} title={t("spaceSections.soonTitle")} text={t("spaceSections.soonText")} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
