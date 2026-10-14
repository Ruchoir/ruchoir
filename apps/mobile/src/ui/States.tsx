import type { LucideIcon } from "lucide-react-native";
import { ActivityIndicator, StyleSheet, View } from "react-native";

import { useTranslation } from "../i18n";
import { radius } from "../theme/tokens";
import { useTheme } from "../theme/useTheme";
import { Button } from "./Button";
import { Text } from "./Text";

/**
 * The design system's empty state (`EmptyState` on the web): the icon as a sticker (on the accent
 * pastel, edged in ink, a little askew on a hard offset shadow), a title, and a sentence that says
 * what will appear here. `hero` fills what is left of a screen, centred; `compact` sits inside
 * content (a day with nothing planned, a search with no result).
 */
export function EmptyState({
  icon: Icon,
  title,
  text,
  size = "hero",
}: {
  icon: LucideIcon;
  title: string;
  text?: string;
  size?: "hero" | "compact";
}) {
  const { c, s } = useTheme();
  const hero = size === "hero";
  const tile = hero ? 64 : 40;
  return (
    <View style={[styles.center, hero ? styles.hero : styles.compact]}>
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[
          styles.sticker,
          {
            width: tile,
            height: tile,
            marginBottom: hero ? 8 : 4,
            backgroundColor: c.acc,
            borderColor: c.ink,
            shadowColor: s.shadow,
            shadowOffset: hero ? { width: 4, height: 4 } : { width: 3, height: 3 },
          },
        ]}
      >
        <Icon size={hero ? 28 : 18} color={c.onPastel} />
      </View>
      <Text variant={hero ? "heading" : "smallStrong"} style={[styles.text, hero && styles.heroTitle]}>
        {title}
      </Text>
      {text ? (
        <Text variant={hero ? "small" : "tiny"} tone={hero ? "body" : "muted"} style={[styles.text, { maxWidth: hero ? 300 : 260 }]}>
          {text}
        </Text>
      ) : null}
    </View>
  );
}

/** A spinner while loading, or what went wrong with a retry: no connection, or a refusal. */
export function LoadState({ error, onRetry }: { error: { offline: boolean } | null; onRetry: () => void }) {
  const { t } = useTranslation();
  const { c } = useTheme();
  if (!error) {
    return (
      <View style={[styles.center, styles.hero]}>
        <ActivityIndicator color={c.ink} />
      </View>
    );
  }
  return (
    <View style={[styles.center, styles.hero]}>
      <Text variant="heading" style={styles.text}>
        {error.offline ? t("load.offline") : t("load.failed")}
      </Text>
      <Button variant="secondary" size="md" label={t("common.retry")} onPress={onRetry} />
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: "center", justifyContent: "center", gap: 12 },
  hero: { flexGrow: 1, padding: 40, gap: 10 },
  compact: { paddingVertical: 24, paddingHorizontal: 16, gap: 6 },
  sticker: {
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderRadius: radius.m,
    transform: [{ rotate: "-4deg" }],
    shadowOpacity: 1,
    shadowRadius: 0,
    elevation: 4,
  },
  text: { textAlign: "center" },
  heroTitle: { fontSize: 20, lineHeight: 26, letterSpacing: -0.4 },
});
