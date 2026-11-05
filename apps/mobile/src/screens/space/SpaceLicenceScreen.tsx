/**
 * A space's Licence section (mockup frame 13, left), for its owner: the days-left banner near the
 * end, a card with the edition, the holder, the seats used ("12 sur 25", guests excluded), the end
 * date with its reminders and who installed it and when, then Remplacer la licence (the install
 * screen) and Retirer la licence behind an Alert. A community space shows its edition and
 * Installer une licence. The state reads again when the space's permissions change.
 *
 * An online licence also shows its mode, its last check-in and "Vérifier maintenant"; a suspended,
 * revoked or unreachable one, or a server whose clock went back, shows why above the card; a renewal
 * waiting to take over shows its dates (`licenceStanding`, shared with the web).
 */
import { refusalOf, type LicenceView, type Workspace } from "@ruchoir/client";
import { daysLeftBanner, licenceStanding } from "@ruchoir/client/permissionsLogic";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { AlertTriangle, Clock, KeyRound, RefreshCw, Trash2 } from "lucide-react-native";
import { useState } from "react";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useApi } from "../../api/useApi";
import { useLoad } from "../../data/useLoad";
import { useReloadOn } from "../../data/useReloadOn";
import { type DictKey, useTranslation } from "../../i18n";
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
  const { getLicence, deleteLicence, checkLicence } = useApi();
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { locale, timeZone } = useLocale();
  const { spaces } = useSpace();
  const toast = useToast();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const licence = useLoad(`licence:${space.id}`, () => getLicence(space.id));
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
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
  const checkNow = async () => {
    setChecking(true);
    try {
      await checkLicence(space.id);
      feel("success");
      toast(t("licence.checked"), "success");
      spaces.reload();
    } catch (err) {
      const refusal = refusalOf(err);
      toast(refusal?.code === "licence_check_too_soon" ? t("licence.refusalService.checkTooSoon") : t("licence.checkFailed"), "failure");
    } finally {
      setChecking(false);
      reload();
    }
  };
  const standing = view ? licenceStanding(view) : null;

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
          {standing?.banner ? (
            <View accessibilityRole="alert" style={[styles.banner, { backgroundColor: `${standing.banner.tone === "danger" ? c.peach : c.sun}40`, borderColor: standing.banner.tone === "danger" ? c.peach : c.sun }]}>
              <AlertTriangle size={18} color={c.ink} style={styles.bannerIcon} />
              <Text variant="small" tone="body" style={styles.bannerText}>
                {t(standing.banner.key as DictKey, standing.banner.since ? { date: day(standing.banner.since, timeZone) } : undefined)}
              </Text>
            </View>
          ) : null}
          {view ? <StateCard view={view} day={day} timeZone={timeZone} /> : <CommunityCard />}
          {owner ? (
            <View style={styles.actions}>
              {standing?.canCheck ? (
                <>
                  <Button
                    label={checking ? t("licence.checking") : t("licence.checkNow")}
                    variant={standing.banner ? "primary" : "secondary"}
                    icon={<RefreshCw size={18} color={standing.banner ? undefined : c.ink} />}
                    onPress={() => void checkNow()}
                    busy={checking}
                  />
                  <Text variant="tiny" tone="muted">
                    {t("licence.sentOnly")}
                  </Text>
                </>
              ) : null}
              {install}
              {view ? (
                <Button label={t("licence.remove")} variant="dangerSoft" icon={<Trash2 size={18} color={s.danger} />} onPress={askRemove} busy={busy} />
              ) : null}
            </View>
          ) : null}
          <Text variant="small" tone="muted">
            {t("licence.earlyHint")}
          </Text>
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
  const standing = licenceStanding(view);
  const pill = standing.tag.tone === "success" ? c.mint : standing.tag.tone === "danger" ? c.peach : c.sun;
  return (
    <View style={[styles.card, { borderColor: c.lineStrong, backgroundColor: c.surface }]}>
      <View style={styles.titleRow}>
        <Text variant="heading" style={styles.title}>
          {view.edition === "frozen" ? t("spaceSections.licenceFrozen") : t("licence.enterprise")}
        </Text>
        {view.edition === "frozen" && !view.status ? null : (
          <View style={[styles.pill, { backgroundColor: `${pill}66`, borderColor: pill }]}>
            <Text variant="label" style={{ color: c.onPastel }}>
              {t(view.status ? (standing.tag.key as DictKey) : "licence.tag.active")}
            </Text>
          </View>
        )}
      </View>
      {standing.modeKey ? (
        <Text variant="small" tone="muted">
          {t(standing.modeKey)}
        </Text>
      ) : null}
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
      {standing.modeKey ? (
        <>
          <View style={styles.line}>
            <Text variant="small" tone="muted">
              {t("licence.lastCheckIn")}
            </Text>
            <Text variant="bodyStrong">{standing.lastCheckInAt ? day(standing.lastCheckInAt, timeZone) : t("licence.checkNever")}</Text>
          </View>
          <Text variant="tiny" tone="muted">
            {standing.canCheck ? t("licence.lastCheckInHint") : t("licence.offlineHint")}
          </Text>
        </>
      ) : null}
      {standing.next ? (
        <Text variant="small" tone="body" style={styles.next}>
          {t(standing.next.key, { from: day(standing.next.validFrom, "UTC"), until: day(standing.next.validUntil, "UTC"), count: standing.next.seats })}
        </Text>
      ) : null}
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
    next: { marginTop: 8 },
  }),
);
