/**
 * The Personnes tab of a role's editor: who holds it directly (each with a way to take it away), who
 * receives it through a group, and Ajouter une personne through the people picker. The guests' role
 * lists every guest and gives to nobody.
 */
import type { Group, Member } from "@ruchoir/client";
import { Plus, UserMinus } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";

import { useTranslation } from "../../i18n";
import { styleCache } from "../../theme/themedStyles";
import { useTheme, useThemedStyles } from "../../theme/useTheme";
import { Avatar } from "../../ui/Avatar";
import { Button } from "../../ui/Button";
import { Text } from "../../ui/Text";

export function RolePeople({
  roleName,
  guests,
  direct,
  viaGroups,
  editable,
  canAdd,
  onAdd,
  onTakeAway,
}: {
  roleName: string;
  guests: boolean;
  direct: Member[];
  viaGroups: { group: Group; members: Member[] }[];
  editable: boolean;
  canAdd: boolean;
  onAdd: () => void;
  onTakeAway: (member: Member) => void;
}) {
  const { t } = useTranslation();
  const { c } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <>
      {guests ? (
        <Text variant="small" tone="muted" style={styles.note}>
          {t("roles.everyGuestHolds")}
        </Text>
      ) : null}
      {viaGroups.length > 0 ? (
        <Text variant="label" tone="muted" style={styles.section}>
          {t("roles.directly")}
        </Text>
      ) : null}
      {direct.length === 0 ? (
        <Text variant="small" tone="muted" style={styles.note}>
          {viaGroups.length > 0 ? t("roles.nobodyDirectly") : t("roles.nobodyHolds")}
        </Text>
      ) : (
        direct.map((member) => (
          <View key={member.userId} style={styles.row}>
            <Avatar name={member.name} src={member.avatarUrl} size={36} />
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
            {editable && !guests && member.manageable ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("roles.takeAway", { name: member.name, role: roleName })}
                hitSlop={8}
                onPress={() => onTakeAway(member)}
              >
                <UserMinus size={20} color={c.muted} />
              </Pressable>
            ) : null}
          </View>
        ))
      )}
      {canAdd ? (
        <View style={styles.add}>
          <Button size="md" variant="secondary" label={t("roles.addPerson")} icon={<Plus size={16} color={c.ink} />} onPress={onAdd} />
        </View>
      ) : null}
      {viaGroups.length > 0 ? (
        <>
          <Text variant="label" tone="muted" style={styles.section}>
            {t("roles.viaGroup")}
          </Text>
          {viaGroups.map(({ group, members }) => (
            <View key={group.id} style={styles.row}>
              <View style={styles.text}>
                <Text variant="bodyStrong" numberOfLines={1}>
                  {group.name}
                </Text>
                <Text variant="tiny" tone="muted" numberOfLines={2}>
                  {members.length > 0 ? members.map((m) => m.name).join(", ") : t("groups.nobody")}
                </Text>
              </View>
            </View>
          ))}
        </>
      ) : null}
    </>
  );
}

const makeStyles = styleCache(() =>
  StyleSheet.create({
    note: { paddingHorizontal: 16, paddingVertical: 10 },
    section: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 4 },
    row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 10, minHeight: 56 },
    text: { flex: 1, minWidth: 0 },
    add: { paddingHorizontal: 16, paddingVertical: 8, alignItems: "flex-start" },
  }),
);
