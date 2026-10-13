import { useColorScheme } from "react-native";

import { semantic, tokens, type Palette } from "./tokens";

export type Theme = { c: Palette; s: ReturnType<typeof semantic>; dark: boolean };

/** The palette in force: violet by day or by night, following the phone's appearance setting. */
export function useTheme(): Theme {
  const dark = useColorScheme() === "dark";
  const c = tokens[dark ? "violet-dark" : "violet"];
  return { c, s: semantic(c, dark), dark };
}
