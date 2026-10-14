import { SquarePen } from "lucide-react-native";
import { Pressable, StyleSheet } from "react-native";

import { useTranslation } from "../../i18n";
import { radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { Text } from "../../ui/Text";

/** "New message", floating over Discussions (mockup 12): the surface, edged and offset in the accent. */
export function NewMessageButton({ onPress }: { onPress: () => void }) {
  const { t } = useTranslation();
  const { c } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.fab,
        { backgroundColor: c.surface, borderColor: c.acc, shadowColor: c.acc },
        pressed && styles.pressed,
      ]}
    >
      <SquarePen size={20} color={c.ink} />
      <Text variant="bodyStrong">{t("newMessage.title")}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fab: {
    position: "absolute",
    right: 16,
    bottom: 16,
    height: 56,
    paddingHorizontal: 18,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: radius.l,
    borderWidth: 2,
    shadowOffset: { width: 4, height: 4 },
    shadowOpacity: 1,
    shadowRadius: 0,
    elevation: 4,
  },
  pressed: { transform: [{ translateX: 2 }, { translateY: 2 }], shadowOffset: { width: 2, height: 2 } },
});
