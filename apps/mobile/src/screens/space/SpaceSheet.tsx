import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Bell, Check, LogOut, Plus, Settings, UserPlus } from "lucide-react-native";
import { StyleSheet, View } from "react-native";

import { useTranslation } from "../../i18n";
import { canAdminister } from "../../logic/spaceRoles";
import type { RootParams } from "../../navigation/types";
import { useSpace } from "../../space/SpaceProvider";
import { radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { ActionRow } from "../../ui/ActionRow";
import { Avatar } from "../../ui/Avatar";
import { Sheet } from "../../ui/Sheet";
import { LoadState } from "../../ui/States";
import { Text } from "../../ui/Text";
import { useLeaveSpace } from "./useLeaveSpace";

/**
 * "Switch space" (mockup 10): every space with its unread count; what the current one offers, as the
 * web's space menu does (inviting and its settings for its owner and admins, its notifications and
 * leaving it for everyone); then creating or joining one.
 */
export function SpaceSheet() {
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const { spaces, current, select } = useSpace();
  const leave = useLeaveSpace();
  // The sheet goes away first, then the screen comes up in its place.
  const open = (screen: "invite" | "spaceSettings" | "spaceNotify") => {
    navigation.goBack();
    navigation.navigate(screen);
  };

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
      {current ? (
        <>
          {/* In the sheet's own typeface: the monospaced label read as another font. */}
          <Text variant="smallStrong" tone="muted" style={styles.section}>
            {current.name}
          </Text>
          {canAdminister(current.role) ? (
            <>
              <ActionRow icon={UserPlus} tint={c.pink} title={t("spaceAdmin.invite")} onPress={() => open("invite")} />
              <ActionRow icon={Settings} tint={c.sky} title={t("spaceAdmin.settings")} onPress={() => open("spaceSettings")} />
            </>
          ) : null}
          <ActionRow icon={Bell} tint={c.sun} title={t("spaceAdmin.notifications")} onPress={() => open("spaceNotify")} />
          <ActionRow
            icon={LogOut}
            tint={s.sunken}
            title={t("spaceAdmin.leave")}
            danger
            onPress={() => {
              navigation.goBack();
              leave(current);
            }}
          />
          <View style={styles.gap} />
        </>
      ) : null}
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
  section: { marginTop: 14, marginBottom: 2 },
  gap: { height: 8 },
  check: { width: 40, height: 40, borderRadius: radius.m, alignItems: "center", justifyContent: "center" },
});
