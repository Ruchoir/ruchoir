/**
 * The small pieces the sharing screens share: the name and the tile of a line (the base line, a role,
 * a group, a reader list, a person), and the level button on its right.
 */
import type { AccessEntry, Group, Member, Role } from "@ruchoir/client";
import { ChevronDown, Lock, MessageSquare, Shield, Users } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";

import { useTranslation } from "../../i18n";
import { roleColourKey } from "../../logic/memberScreen";
import { styleCache } from "../../theme/themedStyles";
import { useTheme, useThemedStyles } from "../../theme/useTheme";
import { Avatar } from "../../ui/Avatar";
import { Text } from "../../ui/Text";
import { GroupTile, useRoleLabel } from "../space/GroupParts";

export type Names = { members: Member[]; groups: Group[]; roles: Role[] };

/** What a line goes by: "Tout l'espace", the person's, the group's or the role's name, or what the line itself says. */
export function useEntryName() {
  const { t } = useTranslation();
  const roleLabel = useRoleLabel();
  return (entry: Pick<AccessEntry, "target" | "guest">, names: Names): string => {
    const { target } = entry;
    const hidden = t("access.hiddenTarget");
    if (target.kind === "everyone") return entry.guest ? t("access.allGuests") : t("channel.everyoneInSpace");
    if (target.kind === "user") return names.members.find((m) => m.userId === target.id)?.name ?? target.name ?? hidden;
    if (target.kind === "group") return names.groups.find((g) => g.id === target.id)?.name ?? target.name ?? hidden;
    if (target.kind === "role") {
      const role = names.roles.find((r) => r.id === target.id);
      return role ? roleLabel(role) : (target.name ?? hidden);
    }
    return target.name ? t("access.audienceName", { name: target.name }) : hidden;
  };
}

/** The 40 tile of a line: a face for a person, the group's square, a shield on the role's colour, the people icon for everyone. */
export function EntryTile({ entry, names }: { entry: AccessEntry; names: Names }) {
  const { c, s } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { target } = entry;
  if (target.kind === "user") {
    const member = names.members.find((m) => m.userId === target.id);
    return <Avatar name={member?.name ?? target.name ?? "?"} src={member?.avatarUrl} size={40} />;
  }
  if (target.kind === "group") return <GroupTile id={target.id ?? target.name ?? ""} />;
  const role = target.kind === "role" ? names.roles.find((r) => r.id === target.id) : undefined;
  const colour = target.kind === "everyone" ? c.mint : target.kind === "role" ? (role ? c[roleColourKey(role)] : c.lineStrong) : s.sunken;
  const Icon = target.kind === "role" ? Shield : target.kind === "audience" ? MessageSquare : Users;
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.tile, { backgroundColor: colour, borderColor: s.edge }]}>
      <Icon size={20} color={c.onPastel} />
    </View>
  );
}

/** The level of a line as a button: its word and a chevron; a lock where it cannot be changed. */
export function LevelButton({ label, accessibilityLabel, onPress, locked }: { label: string; accessibilityLabel: string; onPress?: () => void; locked?: boolean }) {
  const { c } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const body = (
    <>
      {locked ? <Lock size={13} color={c.muted} /> : null}
      <Text variant="smallStrong" numberOfLines={1}>
        {label}
      </Text>
      {onPress ? <ChevronDown size={14} color={c.ink} /> : null}
    </>
  );
  const frame = [styles.level, { borderColor: c.lineStrong, backgroundColor: c.surface }];
  if (!onPress) return <View style={frame}>{body}</View>;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} hitSlop={6} onPress={onPress} style={({ pressed }) => [...frame, pressed && { opacity: 0.6 }]}>
      {body}
    </Pressable>
  );
}

const makeStyles = styleCache((shape) =>
  StyleSheet.create({
    tile: { width: 40, height: 40, borderRadius: shape.radius.m, borderWidth: shape.hairline, alignItems: "center", justifyContent: "center" },
    level: { flexDirection: "row", alignItems: "center", gap: 4, height: 34, paddingHorizontal: 10, borderRadius: shape.radius.s + 2, borderWidth: shape.hairline, maxWidth: 150 },
  }),
);
