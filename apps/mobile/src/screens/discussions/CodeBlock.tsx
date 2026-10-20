/**
 * A fenced code block, as the web's (`features/channel/CodeBlock.tsx`): a dark slab whatever the
 * theme, a head with the language (declared after the fence, else guessed) and a copy button, and
 * the code coloured with the design system's pastels, scrolled sideways rather than wrapped.
 */
import * as Clipboard from "expo-clipboard";
import { Copy } from "lucide-react-native";
import { useMemo } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import { useTranslation } from "../../i18n";
import { highlight, type CodeTone } from "../../logic/highlight";
import { fonts } from "../../theme/fonts";
import { hairline, radius, tokens } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { Text } from "../../ui/Text";
import { useToast } from "../../ui/Toast";

/** The night neutrals: the slab is dark by day as well. */
const SLAB = tokens["sky-dark"];

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const { t } = useTranslation();
  const { c } = useTheme();
  const toast = useToast();
  const { runs, language } = useMemo(() => highlight(code, lang), [code, lang]);
  const color: Record<CodeTone, string> = {
    plain: SLAB.body,
    comment: SLAB.muted,
    keyword: c.acc,
    string: c.mint,
    number: c.sun,
    title: c.pink,
    type: c.violet,
    deletion: c.peach,
  };
  const copy = () => void Clipboard.setStringAsync(code).then(() => toast(t("message.copied")));

  return (
    <View style={[styles.slab, { backgroundColor: SLAB.bg, borderColor: c.ink }]}>
      <View style={[styles.head, { borderBottomColor: SLAB.line }]}>
        <Text variant="tiny" style={{ color: SLAB.muted }}>
          {lang ?? language ?? t("code.text")}
        </Text>
        <Pressable accessibilityRole="button" accessibilityLabel={t("message.copy")} onPress={copy} hitSlop={8} style={styles.copy}>
          <Copy size={13} color={SLAB.muted} />
          <Text variant="tiny" style={{ color: SLAB.muted }}>
            {t("message.copy")}
          </Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.body}>
        <Text variant="small" style={[styles.code, { color: SLAB.body }]}>
          {runs.map((run, i) => (
            <Text key={i} style={[{ color: color[run.tone] }, run.tone === "comment" && styles.italic]}>
              {run.text}
            </Text>
          ))}
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  slab: { borderWidth: hairline, borderRadius: radius.m, overflow: "hidden", marginVertical: 2 },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 10, paddingVertical: 4, borderBottomWidth: hairline },
  copy: { flexDirection: "row", alignItems: "center", gap: 4 },
  body: { paddingHorizontal: 12, paddingVertical: 10 },
  code: { fontFamily: fonts.mono, lineHeight: 19 },
  italic: { fontStyle: "italic" },
});
