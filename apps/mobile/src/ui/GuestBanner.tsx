/**
 * What a guest sees of their own access ending (mockup 14, right): a slim band at the top of every
 * tab ("Invité dans Atelier Rennes · jusqu'au 7 nov."), its colour turning warm within a week of the
 * end, and under the tab's title a card that says what happens next and who to ask. Nothing for
 * anyone else, nor for a guest whose access has no end. The rules are `logic/guestNotices.ts`.
 */
import { Clock, TriangleAlert } from "lucide-react-native";
import { StyleSheet, View } from "react-native";

import { key } from "../i18n";
import { useSharedT } from "../i18n/sharedT";
import { useLocale } from "../i18n/useLocale";
import { joinClosed, tidyPeriods, whenLabel } from "@ruchoir/client/permissionsLogic";
import { useNow } from "../data/useNow";
import { guestBannerFor } from "../logic/guestNotices";
import { deviceZone, shortDay } from "../logic/memberScreen";
import { useSpace } from "../space/SpaceProvider";
import { styleCache } from "../theme/themedStyles";
import { useTheme, useThemedStyles } from "../theme/useTheme";
import { Text } from "./Text";

function useGuestBanner() {
  const { current } = useSpace();
  const now = useNow();
  const { locale } = useLocale();
  const zone = deviceZone();
  const at = new Date(now);
  const state = guestBannerFor(current, at, zone);
  return state && current ? { state, space: current.name, date: shortDay(state.until, locale, zone, at), locale } : null;
}

/** The slim band over a tab. */
export function GuestBand() {
  const say = useSharedT();
  const { c } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const banner = useGuestBanner();
  if (!banner) return null;
  return (
    <View accessibilityRole="summary" style={[styles.band, { backgroundColor: banner.state.tone === "soon" ? c.sun : c.sky }]}>
      <Clock size={14} color={c.onPastel} />
      <Text variant="smallStrong" tone="onPastel" numberOfLines={1} style={styles.bandText}>
        {say(key("guests.bannerUntil"), { space: banner.space, date: banner.date })}
      </Text>
    </View>
  );
}

/** The warning under a tab's title, within a week of the end. */
export function GuestEndCard() {
  const say = useSharedT();
  const { c } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const banner = useGuestBanner();
  if (!banner || !banner.state.card) return null;
  // The first sentence has no period of its own, and the date's abbreviation ("7 nov.") has one.
  const text = joinClosed([
    say("guests.noticeEnding", { space: banner.space, when: whenLabel(banner.state.days, banner.locale) }),
    tidyPeriods(say("guests.noticeEndingDetailBare", { date: banner.date })),
  ]);
  return (
    <View accessibilityRole="alert" style={[styles.card, { backgroundColor: `${c.sun}40`, borderColor: c.sun }]}>
      <TriangleAlert size={18} color={c.ink} style={styles.icon} />
      <Text variant="small" tone="body" style={styles.cardText}>
        {text}
      </Text>
    </View>
  );
}

const makeStyles = styleCache((shape) =>
  StyleSheet.create({
    band: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingVertical: 8 },
    bandText: { flex: 1 },
    card: { flexDirection: "row", gap: 10, marginHorizontal: 16, marginTop: 8, marginBottom: 4, padding: 12, borderRadius: shape.radius.m, borderWidth: shape.hairline },
    icon: { marginTop: 1 },
    cardText: { flex: 1 },
  }),
);
