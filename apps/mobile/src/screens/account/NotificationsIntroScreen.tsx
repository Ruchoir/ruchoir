/**
 * "Don't miss anything important" (mockup 08): shown once after signing in, on a phone that can
 * receive notifications and was never asked (`push/usePhonePush`). The system's own question comes
 * only from the button, never at launch, as both stores ask.
 */
import { useNavigation } from "@react-navigation/native";
import { Bell } from "lucide-react-native";
import { useState } from "react";
import { Image, StyleSheet, View } from "react-native";

import { useSignedInClients } from "../../accounts/AccountsProvider";
import { useTranslation } from "../../i18n";
import { enablePhonePush } from "../../push/phone";
import { hairline, radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { Button } from "../../ui/Button";
import { FullScreen } from "../../ui/FullScreen";
import { Text } from "../../ui/Text";
import { useToast } from "../../ui/Toast";

const mark = require("../../../assets/mark.png");

export function NotificationsIntroScreen() {
  const clients = useSignedInClients();
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const toast = useToast();
  const navigation = useNavigation();
  const [busy, setBusy] = useState(false);

  const enable = async () => {
    setBusy(true);
    try {
      const state = await enablePhonePush(true, clients);
      if (state === "on") toast(t("push.enabled"), "success");
    } catch {
      toast(t("push.failed"), "failure");
    } finally {
      setBusy(false);
      navigation.goBack();
    }
  };

  return (
    <FullScreen color={c.bg}>
      <View style={styles.body}>
        <View style={[styles.preview, { backgroundColor: c.surface, borderColor: c.line, shadowColor: s.shadow }]}>
          <View style={[styles.icon, { backgroundColor: c.bg, borderColor: c.line }]}>
            <Image source={mark} style={[styles.mark, { tintColor: c.brand }]} />
          </View>
          <View style={styles.grow}>
            <View style={styles.row}>
              <Text variant="smallStrong" style={styles.grow} numberOfLines={1}>
                {t("push.introSampleFrom")}
              </Text>
              <Text variant="tiny" tone="muted">
                {t("widgets.now")}
              </Text>
            </View>
            <Text variant="small" tone="body">
              {t("push.introSample")}
            </Text>
          </View>
        </View>
        <Text variant="display" style={styles.center}>
          {t("push.introTitle")}
        </Text>
        <Text tone="body" style={styles.center}>
          {t("push.introBody")}
        </Text>
      </View>
      <View style={styles.actions}>
        <Button label={t("notifPrefs.enabled")} icon={<Bell size={18} color={c.onInk} />} busy={busy} onPress={() => void enable()} />
        <Button variant="ghost" label={t("push.later")} onPress={() => navigation.goBack()} disabled={busy} />
      </View>
    </FullScreen>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, justifyContent: "center", gap: 20, paddingHorizontal: 24 },
  preview: {
    flexDirection: "row",
    gap: 12,
    padding: 14,
    borderRadius: radius.l,
    borderWidth: hairline,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.12,
    shadowRadius: 16,
    elevation: 4,
  },
  icon: { width: 40, height: 40, borderRadius: radius.m, borderWidth: hairline, alignItems: "center", justifyContent: "center" },
  mark: { width: 24, height: 24 },
  grow: { flex: 1, minWidth: 0 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  center: { textAlign: "center" },
  actions: { gap: 8, paddingHorizontal: 20, paddingBottom: 12 },
});
