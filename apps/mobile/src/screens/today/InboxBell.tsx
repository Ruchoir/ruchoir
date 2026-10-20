import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Bell } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";

import { useAccounts } from "../../accounts/AccountsProvider";
import { unreadEverywhere } from "../../accounts/summary";
import { useTranslation } from "../../i18n";
import type { RootParams } from "../../navigation/types";
import { useTheme } from "../../theme/useTheme";
import { Badge } from "../../ui/Badge";

/**
 * Today's bell: the notifications screen, with how many are unread on every instance (ADR 0007):
 * `here` is the count of the instance on screen, live; the others' come from their summaries.
 */
export function InboxBell({ unread: here }: { unread: number }) {
  const { accounts, active, summaries } = useAccounts();
  const others = accounts.filter((a) => a.status.kind === "signedIn" && a.id !== active?.id).map((a) => a.id);
  const unread = here + unreadEverywhere(summaries, others);
  const { t } = useTranslation();
  const { c } = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={unread > 0 ? t("inbox.openUnread", { count: unread }) : t("details.notifications")}
      onPress={() => navigation.navigate("notifications")}
      hitSlop={6}
      style={({ pressed }) => [styles.bell, pressed && { opacity: 0.6 }]}
    >
      <Bell size={22} color={c.ink} />
      {unread > 0 ? (
        <View style={styles.badge}>
          <Badge count={unread} tone="accent" />
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bell: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  badge: { position: "absolute", top: -2, right: -4 },
});
