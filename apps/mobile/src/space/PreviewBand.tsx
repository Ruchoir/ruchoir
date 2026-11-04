/**
 * A thin band that says the space is looked at as a role, for the screens that slide up over the app:
 * a native modal or sheet is drawn above the banner (`PreviewBanner`), which would leave a screen
 * with nothing to say it is a preview. Put at the head of a modal (`SheetHeader`, `FullScreen`,
 * `Sheet`); a modal inside another one's band shows one only.
 */
import { Eye } from "lucide-react-native";
import { createContext, useContext, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";

import { useTranslation } from "../i18n";
import { useTheme } from "../theme/useTheme";
import { Text } from "../ui/Text";
import { useSpaceIfAny } from "./SpaceProvider";

const BandShown = createContext(false);

/** Marks that the band is drawn above: a header inside it does not draw a second one. */
export function BandShownHere({ children }: { children: ReactNode }) {
  return <BandShown.Provider value>{children}</BandShown.Provider>;
}

export function PreviewBand() {
  const above = useContext(BandShown);
  const preview = useSpaceIfAny()?.current?.preview;
  const { t } = useTranslation();
  const { c } = useTheme();
  if (above || !preview) return null;
  return (
    <View accessibilityRole="alert" style={[styles.band, { backgroundColor: c.sun }]}>
      <Eye size={14} color={c.onPastel} />
      <Text variant="tiny" style={{ color: c.onPastel }} numberOfLines={1}>
        {t("preview.bannerTitle", { role: preview.roleName })}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  band: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 4, paddingHorizontal: 16 },
});
