import { useNavigation } from "@react-navigation/native";
import { Check } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";

import { useTranslation } from "../../i18n";
import { useSpace } from "../../space/SpaceProvider";
import { radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { Avatar } from "../../ui/Avatar";
import { Sheet } from "../../ui/Sheet";
import { LoadState } from "../../ui/States";
import { Text } from "../../ui/Text";

/** "Switch space" (mockup 10): every space with its unread count; creating or joining comes in step 5. */
export function SpaceSheet() {
  const { t } = useTranslation();
  const { c } = useTheme();
  const navigation = useNavigation();
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
          <Pressable
            key={space.id}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            onPress={() => {
              select(space.id);
              navigation.goBack();
            }}
            style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
          >
            {selected ? (
              <View style={[styles.check, { backgroundColor: c.sky }]}>
                <Check size={20} color={c.onPastel} />
              </View>
            ) : (
              <Avatar name={space.name} src={space.iconUrl} kind="workspace" size={40} />
            )}
            <View style={styles.flex}>
              <Text variant="bodyStrong" numberOfLines={1}>
                {space.name}
              </Text>
              {selected ? (
                <Text variant="tiny" tone="muted">
                  {t("spaces.current")}
                </Text>
              ) : space.unread > 0 ? (
                <Text variant="tiny" tone="muted">
                  {t("spaces.unread", { count: space.unread })}
                </Text>
              ) : null}
            </View>
          </Pressable>
        );
      })}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  title: { marginBottom: 6 },
  row: { flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 8 },
  check: { width: 40, height: 40, borderRadius: radius.m, alignItems: "center", justifyContent: "center" },
  flex: { flex: 1, minWidth: 0 },
});
