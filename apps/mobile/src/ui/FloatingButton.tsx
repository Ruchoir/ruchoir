import type { LucideIcon } from "lucide-react-native";
import { useCallback, useState } from "react";
import { Pressable, StyleSheet, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";

import { fabCompact } from "../logic/fab";
import { lift } from "../theme/lift";
import { styleCache } from "../theme/themedStyles";
import { useTheme, useThemedStyles } from "../theme/useTheme";
import { Text } from "./Text";

/**
 * The action of a tab, floating over its bottom right ("New message" over Discussions, mockup 12;
 * "New event" over the Agenda, mockup 15; "Add a file" over the Files): the surface, edged and
 * offset in the accent. `compact` shrinks it to its icon while the list is away from its top, so it
 * hides less of what is read (`useFloatingScroll`); its label stays its accessible name.
 */
export function FloatingButton({ icon: Icon, label, onPress, compact = false }: { icon: LucideIcon; label: string; onPress: () => void; compact?: boolean }) {
  const theme = useTheme();
  const { c, s, shape } = theme;
  const styles = useThemedStyles(makeStyles);
  // No layout animation: one runs again each time the screen comes back (a tab, a view) and made
  // the button blink. It changes form at once.
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.fab,
        compact && styles.round,
        // A flat style draws it on a grey edge, without the accent's offset or the press nudge.
        { backgroundColor: c.surface, borderColor: shape.flat ? s.edge : c.acc },
        pressed ? lift(theme, 2, 2, c.acc, 4) : lift(theme, 4, 4, c.acc),
        pressed && !shape.flat && styles.pressed,
      ]}
    >
      <Icon size={20} color={c.ink} />
      {compact ? null : (
        <Text variant="bodyStrong" numberOfLines={1}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

/** Whether a list's floating button is shrunk, and the scroll handler that decides it (`logic/fab.ts`). */
export function useFloatingScroll() {
  const [compact, setCompact] = useState(false);
  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => setCompact(fabCompact(e.nativeEvent.contentOffset.y)), []);
  return { compact, onScroll, scrollEventThrottle: 16 } as const;
}

const makeStyles = styleCache((shape) =>
  StyleSheet.create({
    fab: {
      position: "absolute",
      right: 16,
      bottom: 16,
      height: 56,
      paddingHorizontal: 18,
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      borderRadius: shape.radius.l,
      borderWidth: shape.edgeWidth,
    },
    round: { width: 56, paddingHorizontal: 0, justifyContent: "center", borderRadius: 28 },
    pressed: { transform: [{ translateX: 2 }, { translateY: 2 }] },
  }),
);
