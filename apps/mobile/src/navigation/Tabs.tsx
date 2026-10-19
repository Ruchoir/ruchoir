import { createBottomTabNavigator, type BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { Calendar, Folder, House, MessageSquare, type LucideIcon } from "lucide-react-native";
import { useNavigation } from "@react-navigation/native";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { key, useTranslation } from "../i18n";
import { useWide } from "../layout/useWide";
import { AgendaScreen } from "../screens/agenda/AgendaScreen";
import { DiscussionsScreen } from "../screens/discussions/DiscussionsScreen";
import { FilesScreen } from "../screens/files/FilesScreen";
import { TodayScreen } from "../screens/today/TodayScreen";
import { useSession } from "../session/SessionProvider";
import { selfPresence } from "../session/presence";
import { useSpace } from "../space/SpaceProvider";
import { fonts } from "../theme/fonts";
import { hairline } from "../theme/tokens";
import { useTheme } from "../theme/useTheme";
import { Avatar } from "../ui/Avatar";
import { Badge } from "../ui/Badge";
import { Text } from "../ui/Text";
import type { TabParams } from "./types";

const Tab = createBottomTabNavigator<TabParams>();

const TABS: Record<keyof TabParams, { icon: LucideIcon; label: ReturnType<typeof key> }> = {
  today: { icon: House, label: key("time.today") },
  discussions: { icon: MessageSquare, label: key("tabs.discussions") },
  agenda: { icon: Calendar, label: key("tabs.agenda") },
  files: { icon: Folder, label: key("tabs.files") },
};

/** The four tabs of the mockups, over the bar drawn below; on a wide window the bar is a rail on the left. */
export function Tabs() {
  const wide = useWide();
  return (
    <Tab.Navigator
      screenOptions={{ headerShown: false, tabBarPosition: wide ? "left" : "bottom" }}
      tabBar={(props) => (wide ? <Rail {...props} /> : <TabBar {...props} />)}
    >
      <Tab.Screen name="today" component={TodayScreen} />
      <Tab.Screen name="discussions" component={DiscussionsScreen} />
      <Tab.Screen name="agenda" component={AgendaScreen} />
      <Tab.Screen name="files" component={FilesScreen} />
    </Tab.Navigator>
  );
}

/** The space's counts on Today (mentions) and Discussions (unread messages). */
function useBadges(): Partial<Record<keyof TabParams, number>> {
  const { current } = useSpace();
  return { today: current?.mentions ?? 0, discussions: current?.unread ?? 0 };
}

/**
 * The tablet's rail (the tablet mockups): the space's mark on top, which switches space; the four
 * tabs, the one on screen in a pill of the accent; and the person's own face at the bottom, which
 * opens their account.
 */
function Rail({ state, navigation }: BottomTabBarProps) {
  const { t } = useTranslation();
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const root = useNavigation();
  const { current } = useSpace();
  const { state: session } = useSession();
  const user = session.kind === "signedIn" ? session.user : null;
  const badges = useBadges();
  return (
    <View
      style={[
        styles.rail,
        { backgroundColor: c.surface, borderRightColor: c.line, paddingTop: insets.top + 20, paddingBottom: Math.max(insets.bottom, 16), paddingLeft: insets.left },
      ]}
    >
      {current ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("spaces.switchLabel", { name: current.name })}
          onPress={() => root.navigate("spaceSheet")}
          style={({ pressed }) => [styles.railSpace, pressed && { opacity: 0.6 }]}
        >
          <Avatar name={current.name} src={current.iconUrl} kind="workspace" size={48} />
        </Pressable>
      ) : null}
      {state.routes.map((route, index) => {
        const name = route.name as keyof TabParams;
        const { icon: Icon, label } = TABS[name];
        const active = state.index === index;
        return (
          <Pressable
            key={route.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={t(label)}
            onPress={() => {
              const event = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
              if (!active && !event.defaultPrevented) navigation.navigate(route.name);
            }}
            style={styles.railTab}
          >
            <View style={[styles.railPill, active && { backgroundColor: c.acc }]}>
              <Icon size={22} color={active ? c.onPastel : c.muted} />
              <View style={styles.railBadge}>
                <Badge count={badges[name] ?? 0} />
              </View>
            </View>
            <Text style={[styles.railLabel, { color: active ? c.ink : c.muted, fontFamily: active ? fonts.sansSemibold : fonts.sansMedium }]}>
              {t(label)}
            </Text>
          </Pressable>
        );
      })}
      <View style={styles.fill} />
      {user ? (
        <Pressable accessibilityRole="button" accessibilityLabel={t("account.open")} onPress={() => root.navigate("accountSheet")} style={styles.railMe}>
          <Avatar name={user.name} src={user.avatarUrl} size={44} presence={selfPresence(user.presenceChoice)} />
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * The bar of mockup 09: an ink tick over the tab on screen, its label in the strong weight, and the
 * space's counts on Today and Discussions.
 */
function TabBar({ state, navigation }: BottomTabBarProps) {
  const { t } = useTranslation();
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const badges = useBadges();

  return (
    <View style={[styles.bar, { backgroundColor: c.surface, borderTopColor: c.line, paddingBottom: insets.bottom }]}>
      {state.routes.map((route, index) => {
        const name = route.name as keyof TabParams;
        const { icon: Icon, label } = TABS[name];
        const active = state.index === index;
        const color = active ? c.ink : c.muted;
        return (
          <Pressable
            key={route.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={t(label)}
            onPress={() => {
              const event = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
              if (!active && !event.defaultPrevented) navigation.navigate(route.name);
            }}
            style={styles.tab}
          >
            {active ? <View style={[styles.tick, { backgroundColor: c.ink }]} /> : null}
            <View>
              <Icon size={22} color={color} />
              <View style={styles.badge}>
                <Badge count={badges[name] ?? 0} />
              </View>
            </View>
            <Text variant="tiny" style={{ color, fontFamily: active ? fonts.sansSemibold : fonts.sans }}>
              {t(label)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", borderTopWidth: hairline },
  tab: { flex: 1, minHeight: 60, paddingTop: 8, alignItems: "center", justifyContent: "center", gap: 3 },
  tick: { position: "absolute", top: 0, left: "28%", right: "28%", height: 3, borderBottomLeftRadius: 3, borderBottomRightRadius: 3 },
  badge: { position: "absolute", top: -4, left: 12 },
  // The tablet mockups' rail: 104 wide, the tabs 92 by 72, the pill 64 by 36.
  rail: { width: 104, borderRightWidth: hairline, alignItems: "center", gap: 8 },
  railSpace: { width: 56, height: 56, alignItems: "center", justifyContent: "center", marginBottom: 16 },
  railMe: { width: 56, height: 56, alignItems: "center", justifyContent: "center" },
  railTab: { width: 92, minHeight: 72, alignItems: "center", justifyContent: "center", gap: 6 },
  railPill: { width: 64, height: 36, borderRadius: 999, alignItems: "center", justifyContent: "center" },
  railBadge: { position: "absolute", top: -6, right: 0 },
  railLabel: { fontSize: 13, lineHeight: 17 },
  fill: { flex: 1 },
});
