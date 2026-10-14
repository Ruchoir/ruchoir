/**
 * A tint over a row that lights up, holds a moment and fades: the message someone was taken to (from
 * the pinned tab), as the web's `wc-flash` does. Drawn under the row's content, never in its way.
 */
import { useEffect, useState } from "react";
import { Animated, StyleSheet } from "react-native";

import { useTheme } from "../theme/useTheme";

export function Flash() {
  const { s } = useTheme();
  const [opacity] = useState(() => new Animated.Value(0));
  useEffect(() => {
    const run = Animated.sequence([
      Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true }),
      Animated.delay(900),
      Animated.timing(opacity, { toValue: 0, duration: 700, useNativeDriver: true }),
    ]);
    run.start();
    return () => run.stop();
  }, [opacity]);
  return <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: s.selected, opacity }]} />;
}
