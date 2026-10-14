import type { Reaction } from "@ruchoir/client";
import { SmilePlus } from "lucide-react-native";
import { Alert, Pressable, StyleSheet, View } from "react-native";

import { useTranslation } from "../../i18n";
import { hairline } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { feel } from "../../ui/haptics";
import { Text } from "../../ui/Text";

/**
 * The reactions under a message: the emoji and how many. Mine is tinted with the accent and edged in
 * ink; a tap adds or takes back mine, a long press says who reacted, and `+` opens the picker.
 */
export function ReactionPills({
  reactions,
  onToggle,
  onAdd,
}: {
  reactions: Reaction[];
  onToggle: (emoji: string) => void;
  onAdd: () => void;
}) {
  const { t } = useTranslation();
  const { c, s } = useTheme();
  return (
    <View style={styles.row}>
      {reactions.map((r) => (
        <Pressable
          key={r.emoji}
          accessibilityRole="button"
          accessibilityLabel={t("message.reactionCount", { emoji: r.emoji, count: r.count })}
          accessibilityState={{ selected: !!r.mine }}
          onPress={() => onToggle(r.emoji)}
          onLongPress={() => {
            if (!r.users?.length) return;
            feel("menu");
            Alert.alert(r.emoji, r.users.join(", "));
          }}
          style={({ pressed }) => [
            styles.pill,
            r.mine ? { backgroundColor: s.selected, borderColor: c.ink } : { backgroundColor: c.surface, borderColor: c.line },
            pressed && { opacity: 0.6 },
          ]}
        >
          <Text style={styles.glyph}>{r.emoji}</Text>
          <Text variant="smallStrong" tone={r.mine ? "strong" : "body"}>
            {r.count}
          </Text>
        </Pressable>
      ))}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("message.moreReactions")}
        onPress={onAdd}
        hitSlop={4}
        style={({ pressed }) => [styles.pill, styles.add, { borderColor: c.line }, pressed && { opacity: 0.6 }]}
      >
        <SmilePlus size={16} color={c.muted} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  pill: { flexDirection: "row", alignItems: "center", gap: 4, height: 30, paddingHorizontal: 9, borderRadius: 15, borderWidth: hairline },
  add: { paddingHorizontal: 8 },
  glyph: { fontSize: 15, lineHeight: 20 },
});
