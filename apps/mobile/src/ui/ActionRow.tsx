import type { LucideIcon } from "lucide-react-native";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { radius } from "../theme/tokens";
import { useTheme } from "../theme/useTheme";
import { Text } from "./Text";

type Props = {
  /** An icon on a 40px tile of `tint` (a pastel: the icon is drawn in `onPastel`). */
  icon?: LucideIcon;
  tint?: string;
  /** Instead of an icon: a picture (a face, a space's mark), drawn as given. */
  leading?: ReactNode;
  title: string;
  subtitle?: string;
  onPress?: () => void;
  /** A destructive action: the danger colours, for the title and the tile. */
  danger?: boolean;
  selected?: boolean;
  trailing?: ReactNode;
};

/**
 * One row of a sheet (mockups 10, 11, 14): a tile or a picture, a title, a line under it. Every sheet
 * of the app draws its rows with this, so they share their height, tile and spacing.
 */
export function ActionRow({ icon: Icon, tint, leading, title, subtitle, onPress, danger, selected, trailing }: Props) {
  const { c, s } = useTheme();
  const tileColor = danger ? s.dangerBg : (tint ?? s.sunken);
  const iconColor = danger ? s.danger : tint ? c.onPastel : c.ink;
  const body = (
    <>
      {leading ??
        (Icon ? (
          <View style={[styles.tile, { backgroundColor: tileColor }]}>
            <Icon size={20} color={iconColor} />
          </View>
        ) : null)}
      <View style={styles.text}>
        <Text variant="bodyStrong" tone={danger ? "danger" : "strong"} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="tiny" tone="muted" numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing}
    </>
  );
  if (!onPress) return <View style={styles.row}>{body}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={selected === undefined ? undefined : { selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
    >
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 8, minHeight: 56 },
  tile: { width: 40, height: 40, borderRadius: radius.m, alignItems: "center", justifyContent: "center" },
  text: { flex: 1, minWidth: 0 },
});
