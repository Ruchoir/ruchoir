import { Text as RNText, type TextProps, type TextStyle } from "react-native";

import { fonts } from "../theme/fonts";
import { useTheme } from "../theme/useTheme";

/**
 * Text in the design system's scale (the web's "comfort" sizes) and its two faces.
 *
 * `display` is the 32px heading of the sign-in screens, `title` a screen's own title ("Discussions"),
 * `heading` a section or a sheet, `body` running text, `small` and `tiny` the secondary lines, and
 * `label` the monospace section label.
 */
const VARIANTS = {
  display: { fontSize: 32, lineHeight: 38, fontFamily: fonts.sansBold, letterSpacing: -1.1 },
  title: { fontSize: 28, lineHeight: 34, fontFamily: fonts.sansBold, letterSpacing: -0.8 },
  heading: { fontSize: 17, lineHeight: 22, fontFamily: fonts.sansSemibold },
  body: { fontSize: 15, lineHeight: 21, fontFamily: fonts.sans },
  bodyStrong: { fontSize: 15, lineHeight: 21, fontFamily: fonts.sansSemibold },
  small: { fontSize: 13, lineHeight: 18, fontFamily: fonts.sans },
  smallStrong: { fontSize: 13, lineHeight: 18, fontFamily: fonts.sansSemibold },
  tiny: { fontSize: 12, lineHeight: 16, fontFamily: fonts.sans },
  label: { fontSize: 12, lineHeight: 16, fontFamily: fonts.monoSemibold },
} satisfies Record<string, TextStyle>;

export type TextVariant = keyof typeof VARIANTS;
type Tone = "strong" | "body" | "muted" | "link" | "danger" | "onInk" | "onPastel";

export function Text({
  variant = "body",
  tone = "strong",
  style,
  ...props
}: TextProps & { variant?: TextVariant; tone?: Tone }) {
  const { c, s } = useTheme();
  const color = {
    strong: c.ink,
    body: c.body,
    muted: c.muted,
    link: s.link,
    danger: s.danger,
    onInk: c.onInk,
    onPastel: c.onPastel,
  }[tone];
  return <RNText {...props} style={[VARIANTS[variant], { color }, style]} />;
}
