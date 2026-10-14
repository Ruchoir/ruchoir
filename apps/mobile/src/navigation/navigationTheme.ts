import { DarkTheme, DefaultTheme, type Theme } from "@react-navigation/native";

import { fonts } from "../theme/fonts";
import { useTheme } from "../theme/useTheme";

/** React Navigation's colours and faces, from the theme in force: shared by both navigators. */
export function useNavigationTheme(): Theme {
  const { c, dark } = useTheme();
  const base = dark ? DarkTheme : DefaultTheme;
  return {
    ...base,
    colors: { ...base.colors, primary: c.ink, background: c.bg, card: c.surface, text: c.ink, border: c.line, notification: c.alarm },
    fonts: {
      regular: { fontFamily: fonts.sans, fontWeight: "400" },
      medium: { fontFamily: fonts.sansMedium, fontWeight: "500" },
      bold: { fontFamily: fonts.sansSemibold, fontWeight: "600" },
      heavy: { fontFamily: fonts.sansBold, fontWeight: "700" },
    },
  };
}
