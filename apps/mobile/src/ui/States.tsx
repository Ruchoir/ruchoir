import type { LucideIcon } from "lucide-react-native";
import { ActivityIndicator, StyleSheet, View } from "react-native";

import { useTranslation } from "../i18n";
import { radius } from "../theme/tokens";
import { useTheme } from "../theme/useTheme";
import { Button } from "./Button";
import { Text } from "./Text";

/** A calm "nothing here", centred in what is left of the screen. */
export function EmptyState({ icon: Icon, title, text }: { icon: LucideIcon; title: string; text?: string }) {
  const { c, s } = useTheme();
  return (
    <View style={styles.center}>
      <View style={[styles.tile, { backgroundColor: s.sunken }]}>
        <Icon size={24} color={c.muted} />
      </View>
      <Text variant="heading" style={styles.text}>
        {title}
      </Text>
      {text ? (
        <Text variant="small" tone="muted" style={styles.text}>
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
      <View style={styles.center}>
        <ActivityIndicator color={c.ink} />
      </View>
    );
  }
  return (
    <View style={styles.center}>
      <Text variant="heading" style={styles.text}>
        {error.offline ? t("load.offline") : t("load.failed")}
      </Text>
      <Button variant="secondary" size="md" label={t("boot.retry")} onPress={onRetry} />
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flexGrow: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 12 },
  tile: { width: 56, height: 56, borderRadius: radius.l, alignItems: "center", justifyContent: "center", marginBottom: 4 },
  text: { textAlign: "center" },
});
