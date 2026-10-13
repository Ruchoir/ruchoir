import { createBottomTabNavigator, type BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { Calendar, Folder, House, MessageSquare, type LucideIcon } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { key, useTranslation } from "../i18n";
import { AgendaScreen } from "../screens/agenda/AgendaScreen";
import { DiscussionsScreen } from "../screens/discussions/DiscussionsScreen";
import { FilesScreen } from "../screens/files/FilesScreen";
import { TodayScreen } from "../screens/today/TodayScreen";
import { useSpace } from "../space/SpaceProvider";
import { fonts } from "../theme/fonts";
import { hairline } from "../theme/tokens";
import { useTheme } from "../theme/useTheme";
import { Badge } from "../ui/Badge";
import { Text } from "../ui/Text";
import type { TabParams } from "./types";

const Tab = createBottomTabNavigator<TabParams>();

const TABS: Record<keyof TabParams, { icon: LucideIcon; label: ReturnType<typeof key> }> = {
  today: { icon: House, label: key("tabs.today") },
  discussions: { icon: MessageSquare, label: key("tabs.discussions") },
  agenda: { icon: Calendar, label: key("tabs.agenda") },
  files: { icon: Folder, label: key("tabs.files") },
};

/** The four tabs of the mockups, under the bar drawn below. */
export function Tabs() {
  return (
    <Tab.Navigator screenOptions={{ headerShown: false }} tabBar={(props) => <TabBar {...props} />}>
      <Tab.Screen name="today" component={TodayScreen} />
      <Tab.Screen name="discussions" component={DiscussionsScreen} />
      <Tab.Screen name="agenda" component={AgendaScreen} />
      <Tab.Screen name="files" component={FilesScreen} />
    </Tab.Navigator>
  );
}

/**
 * The bar of mockup 09: an ink tick over the tab on screen, its label in the strong weight, and the
 * space's counts on Today (mentions) and Discussions (unread messages).
 */
function TabBar({ state, navigation }: BottomTabBarProps) {
  const { t } = useTranslation();
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const { current } = useSpace();
  const badges: Partial<Record<keyof TabParams, number>> = {
    today: current?.mentions ?? 0,
    discussions: current?.unread ?? 0,
  };

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
});
