import { useMemo } from "react";
import { useColorScheme } from "react-native";

import { usePrefs } from "../prefs/store";
import { palette, semantic, SHAPES, type Palette, type Shape, type Style } from "./tokens";

export type Theme = { c: Palette; s: ReturnType<typeof semantic>; dark: boolean; style: Style; shape: Shape };

/**
 * The palette in force: the style and the accent chosen in the preferences, by day or by night as
 * they say (the phone's appearance when automatic; a forced mode is also handed to the system, see
 * `prefs/store`). A variant ignores the accent. The same theme object comes back until one of the
 * three changes.
 */
export function useTheme(): Theme {
  const system = useColorScheme() === "dark";
  const { mode, accent, style } = usePrefs();
  const dark = mode === "night" || (mode === "auto" && system);
  return useMemo(() => {
    const c = palette(style, accent, dark);
    return { c, s: semantic(c, dark, style), dark, style, shape: SHAPES[style] };
  }, [style, accent, dark]);
}

/** A file's styles for the style in force (see `themedStyles.ts`). */
export function useThemedStyles<T>(make: (shape: Shape) => T): T {
  return make(useTheme().shape);
}
