/**
 * The two small pieces the groups screens share: a group's square (a pastel that is always the same
 * for the same group, the people icon on it) and the dashed tag the lists wear (Annuaire, Responsable).
 */
import { Plus, Users, X } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";

import { useTranslation } from "../../i18n";
import { groupColour } from "../../logic/groupEditor";
import { systemRoleKey } from "../../logic/memberScreen";
import { styleCache } from "../../theme/themedStyles";
import { useTheme, useThemedStyles } from "../../theme/useTheme";
import { Text } from "../../ui/Text";
import { SYSTEM_ROLE_LABEL } from "./SpaceMembersScreen";

/** A role's name as the screens say it: the base and administrator roles by their dictionary key, the others as named. */
export function useRoleLabel() {
  const { t } = useTranslation();
  return (role: { name: string; systemKey?: "administrator" | "members" | "guests" }) => {
    const named = systemRoleKey(role);
    return named ? t(SYSTEM_ROLE_LABEL[named]) : role.name;
  };
}

/** 40 in lists (radius m), 36 in the editor's header, 32 in a sheet's rows (radius s). */
export function GroupTile({ id, size = 40 }: { id: string; size?: 32 | 36 | 40 }) {
  const { c, s } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.tile, size === 32 ? styles.small : styles.medium, { width: size, height: size, backgroundColor: c[groupColour(id)], borderColor: s.edge }]}
    >
      <Users size={Math.round(size / 2)} color={c.onPastel} />
    </View>
  );
}

export function GroupTag({ label }: { label: string }) {
  const { c } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={[styles.tag, { borderColor: c.lineStrong, backgroundColor: c.surface }]}>
      <Text variant="tiny" tone="muted" numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

/**
 * A group as a pill (the member screen's list): it opens the group's editor when `onPress` is given,
 * and carries a small cross to take the person out of it when `onRemove` is (`removeLabel` names it).
 */
export function GroupChip({ name, onPress, onRemove, removeLabel, disabled }: { name: string; onPress?: () => void; onRemove?: () => void; removeLabel?: string; disabled?: boolean }) {
  const { c } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const body = (
    <>
      <Users size={12} color={c.muted} />
      <Text variant="smallStrong" numberOfLines={1} style={styles.chipLabel}>
        {name}
      </Text>
    </>
  );
  const frame = [styles.chip, { borderColor: c.lineStrong, backgroundColor: c.surface }];
  const label = onPress ? (
    <Pressable accessibilityRole="button" accessibilityLabel={name} onPress={onPress} style={({ pressed }) => [styles.inner, pressed && { opacity: 0.6 }]}>
      {body}
    </Pressable>
  ) : (
    <View style={styles.inner}>{body}</View>
  );
  if (!onRemove) return onPress ? <View style={frame}>{label}</View> : <View style={frame}>{body}</View>;
  return (
    <View style={frame}>
      {label}
      <Pressable accessibilityRole="button" accessibilityLabel={removeLabel ?? name} disabled={disabled} hitSlop={10} onPress={onRemove} style={({ pressed }) => pressed && { opacity: 0.6 }}>
        <X size={12} color={c.muted} />
      </Pressable>
    </View>
  );
}

/** The "+ Ajouter à un groupe" pill of the member screen. */
export function AddToGroupChip({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  const { c, s } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.chip, { borderColor: s.link, backgroundColor: c.surface }, pressed && { opacity: 0.6 }]}>
      <Plus size={12} color={s.link} />
      <Text variant="smallStrong" numberOfLines={1} style={[styles.chipLabel, { color: s.link }]}>
        {label}
      </Text>
    </Pressable>
  );
}

const makeStyles = styleCache((shape) =>
  StyleSheet.create({
    tile: { alignItems: "center", justifyContent: "center", borderWidth: shape.hairline },
    medium: { borderRadius: shape.radius.m },
    small: { borderRadius: shape.radius.s },
    chip: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, height: 26, borderRadius: 13, borderWidth: shape.hairline, alignSelf: "flex-start", maxWidth: "100%" },
    inner: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1 },
    chipLabel: { flexShrink: 1 },
    tag: { borderWidth: shape.hairline, borderRadius: 9, paddingHorizontal: 6, paddingVertical: 1, alignSelf: "center" },
  }),
);
