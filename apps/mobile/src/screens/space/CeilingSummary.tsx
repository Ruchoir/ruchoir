/** "Un invité ne peut jamais": what no setting gives a guest, one plain sentence each (the web's summary). */
import { CEILING_SENTENCES } from "@ruchoir/client/permissionsLogic";
import { X } from "lucide-react-native";
import { StyleSheet, View } from "react-native";

import { key, useTranslation } from "../../i18n";
import { styleCache } from "../../theme/themedStyles";
import { useTheme, useThemedStyles } from "../../theme/useTheme";
import { Text } from "../../ui/Text";

const SENTENCE = {
  directory: key("guests.ceilingDirectory"),
  people: key("guests.ceilingPeople"),
  create: key("guests.ceilingCreate"),
  moderate: key("guests.ceilingModerate"),
  settings: key("guests.ceilingSettings"),
} as const;

export function CeilingSummary() {
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.box}>
      <Text variant="smallStrong">{t("guests.ceilingTitle")}</Text>
      <View style={[styles.list, { backgroundColor: s.sunken, borderColor: c.line }]}>
        {CEILING_SENTENCES.map((sentence, i) => (
          <View key={sentence.id} style={[styles.line, i > 0 && { borderTopColor: c.line, borderTopWidth: StyleSheet.hairlineWidth }]}>
            <X size={14} color={s.danger} />
            <Text variant="small" tone="body" style={styles.sentence}>
              {t(SENTENCE[sentence.id])}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const makeStyles = styleCache((shape) =>
  StyleSheet.create({
    box: { gap: 8, paddingHorizontal: 16, paddingBottom: 8 },
    list: { borderWidth: shape.hairline, borderRadius: shape.radius.m, paddingHorizontal: 12 },
    line: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8 },
    sentence: { flex: 1 },
  }),
);
