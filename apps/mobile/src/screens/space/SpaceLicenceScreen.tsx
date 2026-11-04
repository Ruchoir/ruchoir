/**
 * A space's Licence section (mockup frame 13, left), for its owner: the days-left banner near the
 * end, a card with the edition, the holder, the seats used ("12 sur 25", guests excluded), the end
 * date with its reminders and who installed it and when, then Remplacer la licence (the install
 * screen) and Retirer la licence behind an Alert. A community space shows its edition and
 * Installer une licence. The state reads again when the space's permissions change.
 */
import type { LicenceView, Workspace } from "@ruchoir/client";
import { daysLeftBanner } from "@ruchoir/client/permissionsLogic";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Clock, KeyRound, Trash2 } from "lucide-react-native";
import { useState } from "react";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useApi } from "../../api/useApi";
import { useLoad } from "../../data/useLoad";
import { useReloadOn } from "../../data/useReloadOn";
import { useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { seatsFraction } from "../../logic/licenceFile";
import type { RootParams } from "../../navigation/types";
import { affects } from "../../realtime/events";
import { useSectionGuard } from "../../space/rights";
import { useSpace } from "../../space/SpaceProvider";
import { styleCache } from "../../theme/themedStyles";
import { useTheme, useThemedStyles } from "../../theme/useTheme";
import { BackHeader } from "../../ui/BackHeader";
import { Button } from "../../ui/Button";
import { feel } from "../../ui/haptics";
import { LoadState } from "../../ui/States";
import { Text } from "../../ui/Text";
import { useToast } from "../../ui/Toast";

export function SpaceLicenceScreen() {
  const { c } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { current } = useSpace();
  useSectionGuard("licence");
  return (
    <SafeAreaView edges={["top"]} style={[styles.fill, { backgroundColor: c.bg }]}>
      {current ? <Licence space={current} /> : <BackHeader title="" />}
    </SafeAreaView>
  );
}

function Licence({ space }: { space: Workspace }) {
  const { getLicence, deleteLicence } = useApi();
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { locale, timeZone } = useLocale();
  const { spaces } = useSpace();
  const toast = useToast();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const licence = useLoad(`licence:${space.id}`, () => getLicence(space.id));
  const [busy, setBusy] = useState(false);
  const { reload } = licence;
  // The licence was installed, removed or ran out, here or on another device: read it again.
  useReloadOn((e) => affects.permissions(e, space.id), reload, 300);

  const view = licence.data;
  const owner = space.role === "owner";
  const banner = daysLeftBanner(space.licence, space.edition, new Date(), timeZone);
  const day = (iso: string, zone: string) => new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: zone }).format(new Date(iso));

  const remove = async () => {
    setBusy(true);
    try {
      await deleteLicence(space.id);
      feel("success");
      toast(t("licence.removed"), "success");
      spaces.reload();
    } catch {
      toast(t("licence.removeFailed"), "failure");
    } finally {
      setBusy(false);
      reload();
    }
  };
  const askRemove = () =>
    Alert.alert(t("licence.removeTitle", { space: space.name }), t("licence.removeBody"), [
      { text: t("compose.cancel"), style: "cancel" },
      { text: t("licence.remove"), style: "destructive", onPress: () => void remove() },
    ]);

  const install = (
    <Button
      label={view ? t("licence.replace") : t("licence.installTitle")}
      variant={view ? "secondary" : "primary"}
      icon={<KeyRound size={18} color={view ? c.ink : undefined} />}
      onPress={() => navigation.navigate("licenceInstall")}
      disabled={busy}
    />
  );

  return (
    <>
      <BackHeader title={t("spaceSections.licence")} subtitle={space.name} />
      {licence.data === undefined ? (
        <LoadState error={licence.error} onRetry={reload} />
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          {banner ? (
            <View accessibilityRole="alert" style={[styles.banner, { backgroundColor: `${banner.tone === "danger" ? c.peach : c.sun}40`, borderColor: banner.tone === "danger" ? c.peach : c.sun }]}>
              <Clock size={18} color={c.ink} style={styles.bannerIcon} />
              <Text variant="small" tone="body" style={styles.bannerText}>
                {t("licence.endsIn", { count: banner.days })}
              </Text>
            </View>
          ) : null}
          {view ? <StateCard view={view} day={day} timeZone={timeZone} /> : <CommunityCard />}
          {owner ? (
            <View style={styles.actions}>
              {install}
              {view ? (
                <Button label={t("licence.remove")} variant="dangerSoft" icon={<Trash2 size={18} color={s.danger} />} onPress={askRemove} busy={busy} />
              ) : null}
            </View>
          ) : null}
          <Text variant="small" tone="muted">
            {t("licence.foot")}
          </Text>
        </ScrollView>
      )}
    </>
  );
}

function CommunityCard() {
  const { t } = useTranslation();
  const { c } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={[styles.card, { borderColor: c.lineStrong, backgroundColor: c.surface }]}>
      <Text variant="heading">{t("licence.communityTitle")}</Text>
      <Text variant="small" tone="body">
        {t("licence.communitySubStrong")} {t("licence.communitySubRest")}
      </Text>
    </View>
  );
}

function StateCard({ view, day, timeZone }: { view: LicenceView; day: (iso: string, zone: string) => string; timeZone: string }) {
  const { t } = useTranslation();
  const { c } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { fraction, full } = seatsFraction(view.used, view.seats);
  return (
    <View style={[styles.card, { borderColor: c.lineStrong, backgroundColor: c.surface }]}>
      <View style={styles.titleRow}>
        <Text variant="heading" style={styles.title}>
          {view.edition === "frozen" ? t("spaceSections.licenceFrozen") : t("licence.enterprise")}
        </Text>
        {view.edition === "frozen" ? null : (
          <View style={[styles.pill, { backgroundColor: `${c.mint}66`, borderColor: c.mint }]}>
            <Text variant="label" style={{ color: c.onPastel }}>
              {t("licence.active")}
            </Text>
          </View>
        )}
      </View>
      <Text variant="small" tone="muted">
        {view.organisation}
      </Text>
      <View style={styles.line}>
        <Text variant="small" tone="muted">
          {t("licence.seats")}
        </Text>
        <Text variant="bodyStrong">{t("licence.seatsUsed", { used: view.used, count: view.seats })}</Text>
      </View>
      <View importantForAccessibility="no-hide-descendants" style={[styles.track, { backgroundColor: c.line }]}>
        <View style={[styles.fillBar, { width: `${Math.round(fraction * 100)}%`, backgroundColor: full ? c.peach : c.mint }]} />
      </View>
      <Text variant="tiny" tone="muted">
        {t("licence.guestsFree")}
      </Text>
      <View style={styles.line}>
        <Text variant="small" tone="muted">
          {t("licence.validUntil")}
        </Text>
        <Text variant="bodyStrong">{day(view.validUntil, "UTC")}</Text>
      </View>
      <Text variant="tiny" tone="muted">
        {t("licence.reminders")}
      </Text>
      {view.installedAt ? (
        <>
          <View style={styles.line}>
            <Text variant="small" tone="muted">
              {t("licence.installedOn")}
            </Text>
            <Text variant="bodyStrong">{day(view.installedAt, timeZone)}</Text>
          </View>
          {view.installedBy ? (
            <Text variant="tiny" tone="muted">
              {t("licence.installedBy", { name: view.installedBy.name })}
            </Text>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

const makeStyles = styleCache((shape) =>
  StyleSheet.create({
    fill: { flex: 1 },
    content: { padding: 16, gap: 12, paddingBottom: 32 },
    banner: { flexDirection: "row", gap: 10, padding: 12, borderRadius: shape.radius.m, borderWidth: shape.hairline },
    bannerIcon: { marginTop: 1 },
    bannerText: { flex: 1 },
    card: { padding: 16, gap: 6, borderRadius: shape.radius.l, borderWidth: shape.hairline },
    titleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
    title: { flex: 1 },
    pill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, borderWidth: shape.hairline },
    line: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", marginTop: 8 },
    track: { height: 6, borderRadius: 3, overflow: "hidden" },
    fillBar: { height: 6, borderRadius: 3 },
    actions: { gap: 8 },
  }),
);
