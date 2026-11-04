/**
 * The colour of a role among the seven pastels the server accepts (mockup frame 5, the Nom tab; the
 * new role's sheet offers the same).
 */
import { Check } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";

import { key, useTranslation } from "../../i18n";
import { COLOUR_CHOICES } from "../../logic/roleEditor";
import { useTheme } from "../../theme/useTheme";
import { Text } from "../../ui/Text";

const COLOUR_TEXT = {
  sky: key("prefs.accentSky"),
  mint: key("prefs.accentMint"),
  violet: key("prefs.accentViolet"),
  pink: key("prefs.accentPink"),
  peach: key("calendar.color.peach"),
  lime: key("calendar.color.lime"),
  sun: key("calendar.color.sun"),
} as const;

export function RoleColours({ colour, editable = true, onColour }: { colour: string; editable?: boolean; onColour: (colour: string) => void }) {
  const { t } = useTranslation();
  const { c, s } = useTheme();
  return (
    <View style={styles.colours}>
      <Text variant="smallStrong">{t("calendar.colorLabel")}</Text>
      <View style={styles.swatches} accessibilityRole="radiogroup">
        {COLOUR_CHOICES.map((choice) => {
          const on = choice === colour;
          return (
            <Pressable
              key={choice}
              accessibilityRole="radio"
              accessibilityState={{ checked: on, disabled: !editable }}
              accessibilityLabel={t(COLOUR_TEXT[choice])}
              disabled={!editable}
              onPress={() => onColour(choice)}
              style={[styles.swatch, { backgroundColor: c[choice], borderColor: on ? s.edge : c.lineStrong, borderWidth: on ? 2 : 1 }]}
            >
              {on ? <Check size={16} color={c.onPastel} /> : null}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  colours: { gap: 10 },
  swatches: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  swatch: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
});
