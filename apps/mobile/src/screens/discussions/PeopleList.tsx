import type { Member } from "@ruchoir/client";
import { Check, SearchX } from "lucide-react-native";
import { FlatList, Pressable, StyleSheet, View, type FlatListProps } from "react-native";

import { useTranslation } from "../../i18n";
import { matchPeople } from "../../logic/mentions";
import { hairline, radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { Avatar } from "../../ui/Avatar";
import { EmptyState } from "../../ui/States";
import { Text } from "../../ui/Text";

/** The people matching `query`, accents and case ignored, as the mentions match them; all for none. */
export function filterPeople(people: Member[], query: string): Member[] {
  return query.trim() ? matchPeople(people, query, people.length) : people;
}

/** One person to pick (a conversation, a group): face, name and title, a check when chosen. */
export function PersonRow({ member, selected, onToggle }: { member: Member; selected: boolean; onToggle: (member: Member) => void }) {
  const { c, s } = useTheme();
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
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
      <View style={[styles.box, selected ? { backgroundColor: c.ink, borderColor: c.ink } : { borderColor: c.controlLine }]}>
        {selected ? <Check size={16} color={c.onInk} /> : null}
      </View>
    </Pressable>
  );
}

/**
 * The space's people to pick from, as a list that draws only the rows on screen: a space can hold
 * hundreds of people, and a phone scrolls them smoothly only this way.
 */
export function PeopleList({
  people,
  query,
  selected,
  onToggle,
  ...list
}: {
  people: Member[];
  query: string;
  selected: string[];
  onToggle: (member: Member) => void;
} & Pick<FlatListProps<Member>, "ListHeaderComponent" | "contentContainerStyle" | "style">) {
  const { t } = useTranslation();
  return (
    <FlatList
      {...list}
      data={filterPeople(people, query)}
      keyExtractor={(member) => member.userId}
      extraData={selected}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      automaticallyAdjustKeyboardInsets
      ListEmptyComponent={<EmptyState size="compact" icon={SearchX} title={t("people.none")} />}
      renderItem={({ item }) => <PersonRow member={item} selected={selected.includes(item.userId)} onToggle={onToggle} />}
    />
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 8, minHeight: 56 },
  text: { flex: 1, minWidth: 0 },
  box: { width: 24, height: 24, borderRadius: radius.s, borderWidth: hairline, alignItems: "center", justifyContent: "center" },
});
