import type { LucideIcon } from "lucide-react-native";
import { useCallback, useRef, useState } from "react";
import { Pressable, StyleSheet, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import Animated, { FadeIn, FadeOut, LinearTransition } from "react-native-reanimated";

import { fabStep } from "../logic/fab";
import { radius } from "../theme/tokens";
import { useTheme } from "../theme/useTheme";
import { Text } from "./Text";

/**
 * The action of a tab, floating over its bottom right ("New message" over Discussions, mockup 12;
 * "New event" over the Agenda, mockup 15; "Add a file" over the Files): the surface, edged and
 * offset in the accent. `compact` shrinks it to its icon while the list scrolls down, so it hides
 * less of what is read (`useFloatingScroll`); its label stays its accessible name.
 */
export function FloatingButton({ icon: Icon, label, onPress, compact = false }: { icon: LucideIcon; label: string; onPress: () => void; compact?: boolean }) {
  const { c } = useTheme();
  return (
    // The frame animates its width; the press inside keeps its pressed look.
    <Animated.View layout={LinearTransition.duration(180)} style={[styles.frame, compact && styles.roundFrame]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        style={({ pressed }) => [
          styles.fab,
          compact && styles.round,
          { backgroundColor: c.surface, borderColor: c.acc, shadowColor: c.acc },
          pressed && styles.pressed,
        ]}
      >
        <Icon size={20} color={c.ink} />
        {compact ? null : (
          <Animated.View entering={FadeIn.duration(140)} exiting={FadeOut.duration(80)}>
            <Text variant="bodyStrong" numberOfLines={1}>
              {label}
            </Text>
          </Animated.View>
        )}
      </Pressable>
    </Animated.View>
  );
}

/** Whether a list's floating button is shrunk, and the scroll handler that decides it (`logic/fab.ts`). */
export function useFloatingScroll() {
  const [compact, setCompact] = useState(false);
  const state = useRef({ compact: false, anchor: 0 });
  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    state.current = fabStep(state.current, e.nativeEvent.contentOffset.y);
    setCompact(state.current.compact);
  }, []);
  return { compact, onScroll, scrollEventThrottle: 16 } as const;
}

const styles = StyleSheet.create({
  frame: { position: "absolute", right: 16, bottom: 16 },
  roundFrame: { width: 56 },
  fab: {
    height: 56,
    paddingHorizontal: 18,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: radius.l,
    borderWidth: 2,
    shadowOffset: { width: 4, height: 4 },
    shadowOpacity: 1,
    shadowRadius: 0,
    elevation: 4,
  },
  round: { width: 56, paddingHorizontal: 0, justifyContent: "center", borderRadius: 28 },
  pressed: { transform: [{ translateX: 2 }, { translateY: 2 }], shadowOffset: { width: 2, height: 2 } },
});
