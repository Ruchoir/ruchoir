import { ActivityIndicator, Image, StyleSheet, View } from "react-native";

import { useTranslation } from "../../i18n";
import { useTheme } from "../../theme/useTheme";
import { Button } from "../../ui/Button";
import { Text } from "../../ui/Text";

/** The mark while the Keychain and the session are read, or a retry when the instance did not answer. */
export function BootScreen({ offline, onRetry }: { offline?: boolean; onRetry?: () => void }) {
  const { t } = useTranslation();
  const { c } = useTheme();
  return (
    <View style={[styles.center, { backgroundColor: c.bg }]}>
      <Image source={require("../../../assets/mark.png")} style={[styles.mark, { tintColor: c.brand }]} />
      {offline ? (
        <>
          <Text tone="body" style={styles.message}>
            {t("boot.offline")}
          </Text>
          <Button variant="secondary" size="md" label={t("boot.retry")} onPress={() => onRetry?.()} />
        </>
      ) : (
        <ActivityIndicator color={c.ink} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 18, padding: 24 },
  mark: { width: 56, height: 56 },
  message: { textAlign: "center" },
});
