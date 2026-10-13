import type { Member } from "@ruchoir/client";
import { Check, SearchX } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";

import { useTranslation } from "../../i18n";
import { matchPeople } from "../../logic/mentions";
import { hairline, radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { Avatar } from "../../ui/Avatar";
import { EmptyState } from "../../ui/States";
import { Text } from "../../ui/Text";

/**
 * The space's people to pick from (a conversation, a group): face, name and title, a check on those
 * chosen. Filtered by `query` as the mentions are, accents and case ignored.
 */
export function PeopleList({
  people,
  query,
  selected,
  onToggle,
}: {
  people: Member[];
  query: string;
  selected: string[];
  onToggle: (member: Member) => void;
}) {
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const shown = query.trim() ? matchPeople(people, query, people.length) : people;
  if (shown.length === 0) return <EmptyState size="compact" icon={SearchX} title={t("people.none")} />;
  return (
    <View>
      {shown.map((member) => {
        const on = selected.includes(member.userId);
        return (
          <Pressable
            key={member.userId}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: on }}
            onPress={() => onToggle(member)}
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: s.pressed }]}
          >
            <Avatar name={member.name} src={member.avatarUrl} size={40} />
            <View style={styles.text}>
              <Text variant="bodyStrong" numberOfLines={1}>
                {member.name}
              </Text>
              {member.title ? (
                <Text variant="tiny" tone="muted" numberOfLines={1}>
                  {member.title}
                </Text>
              ) : null}
            </View>
            <View style={[styles.box, on ? { backgroundColor: c.ink, borderColor: c.ink } : { borderColor: c.controlLine }]}>
              {on ? <Check size={16} color={c.onInk} /> : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 8, minHeight: 56 },
  text: { flex: 1, minWidth: 0 },
  box: { width: 24, height: 24, borderRadius: radius.s, borderWidth: hairline, alignItems: "center", justifyContent: "center" },
});
