import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import { CalendarArrowDown, CalendarDays, CalendarRange } from "lucide-react-native";
import { StyleSheet } from "react-native";

import { useTranslation } from "../../../i18n";
import type { RootParams } from "../../../navigation/types";
import { useTheme } from "../../../theme/useTheme";
import { ActionRow } from "../../../ui/ActionRow";
import { Sheet } from "../../../ui/Sheet";
import { Text } from "../../../ui/Text";
import { requestScope } from "./scope";

/** A change to a date of a series (the web's `SeriesScopeDialog`): this one, it and the next ones, or
 *  the whole series. */
export function ScopeSheet() {
  const { params } = useRoute<RouteProp<RootParams, "eventScope">>();
  const navigation = useNavigation();
  const { t } = useTranslation();
  const { c } = useTheme();
  const remove = params.action === "delete";
  const choose = (scope: "this" | "following" | "all") => {
    navigation.goBack();
    requestScope({ key: params.key, scope });
  };
  return (
    <Sheet>
      <Text variant="heading">
        {remove ? t("calendar.scopeDeleteTitle", { title: params.title }) : t("calendar.scopeEditTitle", { title: params.title })}
      </Text>
      <Text variant="small" tone="muted" style={styles.intro}>
        {t("calendar.scopeIntro")}
      </Text>
      <ActionRow icon={CalendarDays} tint={c.sky} danger={remove} title={t("calendar.scopeThis")} subtitle={t("calendar.scopeThisHint")} onPress={() => choose("this")} />
      <ActionRow
        icon={CalendarArrowDown}
        tint={c.violet}
        danger={remove}
        title={t("calendar.scopeFollowing")}
        subtitle={t("calendar.scopeFollowingHint")}
        onPress={() => choose("following")}
      />
      <ActionRow icon={CalendarRange} tint={c.mint} danger={remove} title={t("calendar.scopeAll")} subtitle={t("calendar.scopeAllHint")} onPress={() => choose("all")} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  intro: { marginBottom: 6 },
});
