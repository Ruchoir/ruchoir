import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Users } from "lucide-react-native";
import { Pressable, StyleSheet } from "react-native";

import { useSupports } from "../../api/features";
import { useTranslation } from "../../i18n";
import type { RootParams } from "../../navigation/types";
import { useTheme } from "../../theme/useTheme";

/**
 * The agenda's way to the sharing of a space calendar: for whoever manages one, on an instance that
 * sets access by levels (`resource_rules`). It opens the list of those calendars.
 */
export function CalendarShareButton({ canShare }: { canShare: boolean | undefined }) {
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const levels = useSupports("resource_rules");
  if (!canShare || !levels) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("access.calendarsTitle")}
      hitSlop={6}
      onPress={() => navigation.navigate("calendarShare")}
      style={({ pressed }) => [styles.button, { backgroundColor: s.sunken }, pressed && { opacity: 0.6 }]}
    >
      <Users size={18} color={c.ink} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", marginRight: 8 },
});
