import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Check, Plus } from "lucide-react-native";
import { StyleSheet, View } from "react-native";

import { useTranslation } from "../../i18n";
import type { RootParams } from "../../navigation/types";
import { useSpace } from "../../space/SpaceProvider";
import { radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { ActionRow } from "../../ui/ActionRow";
import { Avatar } from "../../ui/Avatar";
import { Sheet } from "../../ui/Sheet";
import { LoadState } from "../../ui/States";
import { Text } from "../../ui/Text";

/** "Switch space" (mockup 10): every space with its unread count, then creating or joining one. */
export function SpaceSheet() {
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const { spaces, current, select } = useSpace();

  return (
    <Sheet>
      <Text variant="heading" style={styles.title}>
        {t("spaces.title")}
      </Text>
      {!spaces.data ? <LoadState error={spaces.error} onRetry={spaces.reload} /> : null}
      {spaces.data?.map((space) => {
        const selected = space.id === current?.id;
        return (
          <ActionRow
            key={space.id}
            selected={selected}
            onPress={() => {
              select(space.id);
              navigation.goBack();
            }}
            leading={
              selected ? (
                <View style={[styles.check, { backgroundColor: c.sky }]}>
                  <Check size={20} color={c.onPastel} />
                </View>
              ) : (
                <Avatar name={space.name} src={space.iconUrl} kind="workspace" size={40} />
              )
            }
            title={space.name}
            subtitle={selected ? t("spaces.current") : space.unread > 0 ? t("spaces.unread", { count: space.unread }) : undefined}
          />
        );
      })}
      <ActionRow
        icon={Plus}
        tint={s.sunken}
        title={t("joinSpace.modalTitle")}
        subtitle={t("joinSpace.rowHint")}
        onPress={() => {
          navigation.goBack();
          navigation.navigate("joinSpace");
        }}
      />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  title: { marginBottom: 6 },
  check: { width: 40, height: 40, borderRadius: radius.m, alignItems: "center", justifyContent: "center" },
});
