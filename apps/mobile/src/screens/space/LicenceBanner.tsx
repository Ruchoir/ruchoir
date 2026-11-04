/**
 * The owner's reminder in the space settings, outside the Licence screen: the licence ends within
 * 30 days (sharper in the last week), or it already expired and froze. Shown by the section list;
 * `spaceLicenceBanner` (shared with the web) decides who it is for.
 */
import type { Workspace } from "@ruchoir/client";
import { spaceLicenceBanner } from "@ruchoir/client/permissionsLogic";
import { Clock } from "lucide-react-native";
import { StyleSheet, View } from "react-native";

import { useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { styleCache } from "../../theme/themedStyles";
import { useTheme, useThemedStyles } from "../../theme/useTheme";
import { Text } from "../../ui/Text";

export function LicenceBanner({ space }: { space: Workspace | null }) {
  const { t } = useTranslation();
  const { timeZone } = useLocale();
  const { c } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const banner = space ? spaceLicenceBanner(space, new Date(), timeZone) : null;
  if (!banner) return null;
  const tone = banner.kind === "frozen" || banner.tone === "danger" ? c.peach : c.sun;
  return (
    <View accessibilityRole="alert" style={[styles.banner, { backgroundColor: `${tone}40`, borderColor: tone }]}>
      <Clock size={18} color={c.ink} style={styles.icon} />
      <Text variant="small" tone="body" style={styles.text}>
        {banner.kind === "frozen" ? t("licence.frozenBanner") : t("licence.endsIn", { count: banner.days })}
      </Text>
    </View>
  );
}

const makeStyles = styleCache((shape) =>
  StyleSheet.create({
    banner: { flexDirection: "row", gap: 10, padding: 12, borderRadius: shape.radius.m, borderWidth: shape.hairline, marginBottom: 12 },
    icon: { marginTop: 1 },
    text: { flex: 1 },
  }),
);
