import { useNavigation } from "@react-navigation/native";
import { ChevronLeft } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";

import { useTranslation } from "../../i18n";
import { useSession } from "../../session/SessionProvider";
import { useTheme } from "../../theme/useTheme";

/**
 * The back arrow at the top of a screen before sign-in (mockups 05 and 06), when there is a way back:
 * the screen before, or the app itself when an instance is being added from it.
 */
export function AuthTop({ onBack }: { onBack?: () => void }) {
  const { t } = useTranslation();
  const { c } = useTheme();
  const navigation = useNavigation();
  const { cancel } = useSession();
  const back = onBack ?? (navigation.canGoBack() ? () => navigation.goBack() : cancel);
  if (!back) return <View style={styles.room} />;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("common.back")}
      onPress={back}
      style={styles.back}
      hitSlop={8}
    >
      <ChevronLeft size={26} color={c.ink} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  back: { width: 44, height: 44, marginLeft: -12, marginBottom: -10, alignItems: "center", justifyContent: "center" },
  room: { height: 12 },
});
