import { Users } from "lucide-react-native";
import { StyleSheet, View } from "react-native";

import type { RoleColour } from "../logic/memberScreen";
import { styleCache } from "../theme/themedStyles";
import { useTheme, useThemedStyles } from "../theme/useTheme";
import { Text } from "./Text";

/**
 * A role as a pastille (mockups 2 and 3): its colour as a dot, its name. `viaGroup` adds the small
 * group icon of a role someone receives through a group rather than directly.
 */
export function RoleChip({ label, colour, viaGroup }: { label: string; colour: RoleColour; viaGroup?: boolean }) {
  const { c } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={[styles.chip, { borderColor: c.lineStrong, backgroundColor: c.surface }]}>
      <View style={[styles.dot, { backgroundColor: colour === "line" ? c.lineStrong : c[colour] }]} />
      <Text variant="smallStrong" numberOfLines={1} style={styles.label}>
        {label}
      </Text>
      {viaGroup ? <Users size={12} color={c.muted} /> : null}
    </View>
  );
}

const makeStyles = styleCache((shape) =>
  StyleSheet.create({
    chip: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, height: 26, borderRadius: 13, borderWidth: shape.hairline, alignSelf: "flex-start", maxWidth: "100%" },
    dot: { width: 8, height: 8, borderRadius: 4 },
    label: { flexShrink: 1 },
  }),
);
