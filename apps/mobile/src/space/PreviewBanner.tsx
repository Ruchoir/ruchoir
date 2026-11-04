/**
 * The yellow band over the whole app while the space is looked at as a role (mockup frame 6): who is
 * looked at, that nothing can be written, how long it lasts without activity, and the way out. Mounted
 * once by the space gate, above the tabs and every screen pushed over them. The band is the only thing
 * the preview adds; the screens below it are the role's own.
 */
import { Eye } from "lucide-react-native";
import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useApi } from "../api/useApi";
import { useTranslation } from "../i18n";
import { bannerWords } from "../logic/preview";
import { styleCache } from "../theme/themedStyles";
import { useTheme, useThemedStyles } from "../theme/useTheme";
import { feel } from "../ui/haptics";
import { Text } from "../ui/Text";
import { useToast } from "../ui/Toast";
import { useSpace } from "./SpaceProvider";

export function PreviewBanner({ onQuit }: { onQuit: (quitting: boolean) => void }) {
  const { current, spaces } = useSpace();
  const { quitPreview } = useApi();
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const preview = current?.preview;
  if (!current || !preview) return null;
  const words = bannerWords(preview, current.name);

  const quit = async () => {
    setBusy(true);
    try {
      // Said first: the end that follows is the person's own, not one to announce.
      onQuit(true);
      await quitPreview(current.id);
      feel("success");
    } catch {
      onQuit(false);
      toast(t("preview.quitFailed"), "failure");
    } finally {
      setBusy(false);
      // Whatever the answer: a preview that had already ended on the server (idle, another device)
      // answers an error here, and only a fresh read of the spaces takes the banner away.
      spaces.reload();
    }
  };

  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={[styles.band, { paddingTop: insets.top + 8, backgroundColor: c.sun, borderBottomColor: s.edge }]}
    >
      <Eye size={18} color={c.onPastel} />
      <View style={styles.text}>
        <Text variant="smallStrong" style={{ color: c.onPastel }}>
          {t("preview.bannerTitle", { role: words.role })}
        </Text>
        <Text variant="tiny" style={{ color: c.onPastel }}>
          {t("preview.note", { minutes: words.minutes })}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("preview.quit")}
        disabled={busy}
        onPress={() => void quit()}
        style={({ pressed }) => [styles.quit, { backgroundColor: c.ink }, (pressed || busy) && { opacity: 0.7 }]}
      >
        <Text variant="smallStrong" tone="onInk">
          {t("preview.quit")}
        </Text>
      </Pressable>
    </View>
  );
}

const makeStyles = styleCache((shape) =>
  StyleSheet.create({
    band: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingBottom: 10, borderBottomWidth: shape.hairline },
    text: { flex: 1, minWidth: 0 },
    quit: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: shape.radius.m },
  }),
);
