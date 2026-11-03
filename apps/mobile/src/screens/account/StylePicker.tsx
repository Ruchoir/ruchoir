import { Check } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";

import { key, useTranslation } from "../../i18n";
import { setPrefs, usePrefs } from "../../prefs/store";
import { styleCache } from "../../theme/themedStyles";
import { palette, semantic, SHAPES, STYLES, type Style } from "../../theme/tokens";
import { useTheme, useThemedStyles } from "../../theme/useTheme";
import { Text } from "../../ui/Text";

const STYLE_TEXT: Record<Style, ReturnType<typeof key>> = {
  ruchoir: key("prefs.styleRuchoir"),
  aubergine: key("prefs.styleAubergine"),
  nuage: key("prefs.styleNuage"),
  indigo: key("prefs.styleIndigo"),
  marine: key("prefs.styleMarine"),
};

/**
 * The Style choice (the web's `StylePicker`): five cards, each a small picture of the style by day or
 * by night as the phone is now (its band, a line of text on its page, its primary colour), its name
 * under it. The one in force is edged in the focus colour and ticked.
 */
export function StylePicker() {
  const { t } = useTranslation();
  const { c, s, dark } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { style: chosen, accent } = usePrefs();
  return (
    <View style={styles.cards} accessibilityRole="radiogroup">
      {STYLES.map((style) => {
        const on = style === chosen;
        const p = palette(style, accent, dark);
        const look = semantic(p, dark, style);
        const corner = SHAPES[style].radius.m;
        return (
          <Pressable
            key={style}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            accessibilityLabel={t(STYLE_TEXT[style])}
            onPress={() => setPrefs({ style })}
            style={styles.card}
          >
            <View style={[styles.preview, { borderColor: on ? s.focus : c.line, borderWidth: on ? 2 : 1, borderRadius: corner + 2 }]}>
              <View style={[styles.inner, { backgroundColor: p.bg, borderRadius: corner }]}>
                <View style={[styles.band, { backgroundColor: look.bar }]} />
                <View style={[styles.page, { backgroundColor: p.surface }]}>
                  <View style={[styles.dash, { backgroundColor: p.ink, width: "70%" }]} />
                  <View style={[styles.dash, { backgroundColor: p.muted, width: "45%" }]} />
                  <View style={[styles.dot, { backgroundColor: look.primary }]} />
                </View>
              </View>
              {on ? (
                <View style={[styles.tick, { backgroundColor: s.focus }]}>
                  <Check size={12} color={c.bg} strokeWidth={3} />
                </View>
              ) : null}
            </View>
            <Text variant={on ? "smallStrong" : "small"} numberOfLines={1}>
              {t(STYLE_TEXT[style])}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const makeStyles = styleCache((shape) =>
  StyleSheet.create({
    cards: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
    card: { width: 96, gap: 6, alignItems: "center" },
    preview: { width: 96, height: 64, padding: 3 },
    inner: { flex: 1, flexDirection: "row", overflow: "hidden" },
    band: { width: 14 },
    page: { flex: 1, padding: 8, gap: 5, borderLeftWidth: shape.hairline, borderLeftColor: "transparent" },
    dash: { height: 5, borderRadius: 3 },
    dot: { width: 16, height: 8, borderRadius: 4, marginTop: "auto", alignSelf: "flex-end" },
    tick: {
      position: "absolute",
      top: -6,
      right: -6,
      width: 20,
      height: 20,
      borderRadius: 10,
      alignItems: "center",
      justifyContent: "center",
    },
  }),
);
