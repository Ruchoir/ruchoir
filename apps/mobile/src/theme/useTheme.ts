import { useColorScheme } from "react-native";

import { usePrefs } from "../prefs/store";
import { semantic, themeName, tokens, type Palette } from "./tokens";

export type Theme = { c: Palette; s: ReturnType<typeof semantic>; dark: boolean };

/**
 * The palette in force: the accent chosen in the preferences, by day or by night as they say (the
 * phone's appearance when automatic; a forced mode is also handed to the system, see `prefs/store`).
 */
export function useTheme(): Theme {
  const system = useColorScheme() === "dark";
  const { mode, accent } = usePrefs();
  const dark = mode === "night" || (mode === "auto" && system);
  const c = tokens[themeName(accent, dark)];
  return { c, s: semantic(c, dark), dark };
}
