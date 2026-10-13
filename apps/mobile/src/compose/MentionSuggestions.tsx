import { Hash, Megaphone } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";

import { hairline, radius } from "../theme/tokens";
import { useTheme } from "../theme/useTheme";
import { Avatar } from "../ui/Avatar";
import { Text } from "../ui/Text";

export type Suggestion =
  | { kind: "person"; key: string; name: string; detail?: string; avatar?: string; bot?: boolean }
  | { kind: "broadcast"; key: string; name: string; detail: string }
  | { kind: "channel"; key: string; name: string; detail?: string };

/**
 * What `@` or `#` can become, above the composer: people with their face and title, the two room-wide
 * names with what they do, or channels. A tap inserts the name.
 */
export function MentionSuggestions({ items, onPick }: { items: Suggestion[]; onPick: (item: Suggestion) => void }) {
  const { c, s } = useTheme();
  if (items.length === 0) return null;
  return (
    <View style={[styles.list, { backgroundColor: c.surface, borderBottomColor: c.line }]} accessibilityRole="menu">
      {items.map((item) => (
        <Pressable
          key={item.key}
          accessibilityRole="menuitem"
          onPress={() => onPick(item)}
          style={({ pressed }) => [styles.row, pressed && { backgroundColor: s.pressed }]}
        >
          {item.kind === "person" ? (
            <Avatar name={item.name} src={item.avatar} kind={item.bot ? "bot" : "person"} size={32} />
          ) : (
            <View style={[styles.tile, { backgroundColor: item.kind === "broadcast" ? c.sun : c.mint }]}>
              {item.kind === "broadcast" ? <Megaphone size={16} color={c.onPastel} /> : <Hash size={16} color={c.onPastel} />}
            </View>
          )}
          <View style={styles.text}>
            <Text variant="bodyStrong" numberOfLines={1}>
              {item.kind === "channel" ? `#${item.name}` : item.kind === "broadcast" ? `@${item.name}` : item.name}
            </Text>
            {item.detail ? (
              <Text variant="tiny" tone="muted" numberOfLines={1}>
                {item.detail}
              </Text>
            ) : null}
          </View>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { borderBottomWidth: hairline, paddingVertical: 4 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, minHeight: 52 },
  tile: { width: 32, height: 32, borderRadius: radius.m, alignItems: "center", justifyContent: "center" },
  text: { flex: 1, minWidth: 0 },
});
