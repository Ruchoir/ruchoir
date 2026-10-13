import { useNavigation } from "@react-navigation/native";
import { ChevronDown } from "lucide-react-native";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { useTranslation } from "../i18n";
import { useSession } from "../session/SessionProvider";
import { selfPresence } from "../session/presence";
import { useSpace } from "../space/SpaceProvider";
import { radius } from "../theme/tokens";
import { useTheme } from "../theme/useTheme";
import { Avatar } from "./Avatar";
import { Text } from "./Text";

/**
 * The head of every tab (mockups 09, 12, 15, 20): an optional line above the title, the title, the
 * space switcher under it, and the person's own avatar, which opens their account sheet.
 */
export function TabHeader({ title, overline, children }: { title: string; overline?: string; children?: ReactNode }) {
  const navigation = useNavigation();
  const { t } = useTranslation();
  const { c } = useTheme();
  const { state } = useSession();
  const { current } = useSpace();
  const user = state.kind === "signedIn" ? state.user : null;

  return (
    <View style={styles.head}>
      <View style={styles.titles}>
        {overline ? (
          <Text variant="small" tone="muted" style={styles.overline}>
            {overline}
          </Text>
        ) : null}
        <Text variant="title" numberOfLines={1}>
          {title}
        </Text>
        {current ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("spaces.switchLabel", { name: current.name })}
            onPress={() => navigation.navigate("spaceSheet")}
            style={({ pressed }) => [styles.space, pressed && { opacity: 0.6 }]}
          >
            <Avatar name={current.name} src={current.iconUrl} kind="workspace" size={24} />
            <Text variant="bodyStrong" tone="body" numberOfLines={1} style={styles.spaceName}>
              {current.name}
            </Text>
            <ChevronDown size={16} color={c.body} />
          </Pressable>
        ) : null}
        {children}
      </View>
      {user ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("account.open")}
          onPress={() => navigation.navigate("accountSheet")}
          style={styles.me}
        >
          <Avatar name={user.name} size={36} presence={selfPresence(user.presenceChoice)} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "flex-start", paddingHorizontal: 16, paddingTop: 14, paddingBottom: 6, gap: 12 },
  titles: { flex: 1, minWidth: 0 },
  overline: { fontFamily: "IBMPlexSans-Medium" },
  space: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 40,
    marginLeft: -6,
    paddingHorizontal: 6,
    borderRadius: radius.m,
    alignSelf: "flex-start",
    maxWidth: "100%",
  },
  spaceName: { flexShrink: 1 },
  me: { padding: 4 },
});
