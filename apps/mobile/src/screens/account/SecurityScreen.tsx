import { getMfaState, logoutEverywhere, removePasskey, generateRecoveryCodes } from "@ruchoir/client";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { KeyRound, ListChecks, Lock, LogOut, Plus, ShieldCheck, Trash2 } from "lucide-react-native";
import { useCallback } from "react";
import { Alert, Pressable, ScrollView, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useLoad } from "../../data/useLoad";
import { useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { addPasskeyThroughBrowser, canUseBrowserHandoff } from "../../auth/browser";
import { useAppLock } from "../../lock/AppLock";
import type { RootParams } from "../../navigation/types";
import { useSession } from "../../session/SessionProvider";
import { useTheme } from "../../theme/useTheme";
import { ActionRow } from "../../ui/ActionRow";
import { BackHeader } from "../../ui/BackHeader";
import { LoadState } from "../../ui/States";
import { Text } from "../../ui/Text";
import { Toggle } from "../../ui/Toggle";
import { useToast } from "../../ui/Toast";
import { Section } from "./Section";

/**
 * Security, as the web's: the password, two-factor authentication and its recovery codes, the
 * passkeys (added through the instance's web page, `auth/browser.ts`; removable here), and signing
 * out of every device. Plus what only a phone has: locking the app with Face ID (`lock/AppLock`).
 */
export function SecurityScreen() {
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const { locale } = useLocale();
  const toast = useToast();
  const session = useSession();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const mfa = useLoad("mfa", (signal) => getMfaState(signal));
  const { reload } = mfa;
  // Back from a form that changed something (two-factor on or off, new codes): read it again.
  useFocusEffect(useCallback(() => reload(), [reload]));
  const day = (iso: string) => new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric" }).format(new Date(iso));

  const newCodes = () =>
    Alert.alert(t("security.newCodesTitle"), t("security.newCodesText"), [
      { text: t("compose.cancel"), style: "cancel" },
      {
        text: t("security.generate"),
        onPress: () =>
          void generateRecoveryCodes().then(
            (codes) => navigation.navigate("recoveryCodes", { codes }),
            () => toast(t("security.generateFailed"), "failure"),
          ),
      },
    ]);

  const forget = (id: string, label: string) =>
    Alert.alert(t("security.removePasskeyTitle", { name: label }), t("security.removePasskeyText"), [
      { text: t("compose.cancel"), style: "cancel" },
      {
        text: t("security.remove"),
        style: "destructive",
        onPress: () =>
          void removePasskey(id).then(
            () => {
              toast(t("security.passkeyRemoved"));
              reload();
            },
            () => toast(t("load.failed"), "failure"),
          ),
      },
    ]);

  const everywhere = () =>
    Alert.alert(t("security.signOutEverywhere"), t("security.sessionsDesc"), [
      { text: t("compose.cancel"), style: "cancel" },
      {
        text: t("security.signOutEverywhere"),
        style: "destructive",
        onPress: () =>
          void logoutEverywhere().then(
            () => session.signOut(),
            () => toast(t("security.signOutFailed"), "failure"),
          ),
      },
    ]);

  const lock = useAppLock();
  const server = session.state.kind === "signedIn" ? session.state.server : null;
  const addPasskey = () => {
    if (!server) return;
    addPasskeyThroughBrowser(server).then(
      (added) => {
        if (!added) return;
        toast(t("security.passkeyAdded"), "success");
        reload();
      },
      () => toast(t("security.addPasskeyFailed"), "failure"),
    );
  };
  const lockTitle = {
    faceId: t("security.lockFaceId"),
    touchId: t("security.lockTouchId"),
    biometrics: t("security.lockBiometrics"),
    passcode: t("security.lockPasscode"),
  }[lock.kind ?? "faceId"];

  const state = mfa.data;
  return (
    <SafeAreaView style={[styles.fill, { backgroundColor: c.bg }]} edges={["top"]}>
      <BackHeader title={t("account.security")} />
      <ScrollView contentContainerStyle={styles.content}>
        <Section label={t("signIn.password")}>
          <ActionRow
            icon={KeyRound}
            tint={c.sky}
            title={t("security.changePassword")}
            subtitle={t("security.passwordRowDesc")}
            onPress={() => navigation.navigate("changePassword")}
          />
        </Section>
        <Section label={t("security.twoFactor")}>
          {!state ? (
            <LoadState error={mfa.error} onRetry={reload} />
          ) : (
            <>
              <ActionRow
                icon={ShieldCheck}
                tint={state.totpEnabled ? c.mint : s.sunken}
                title={state.totpEnabled ? t("security.enabled") : t("security.disabled")}
                subtitle={state.totpEnabled ? t("security.totpOn") : t("security.totpOff")}
                trailing={
                  <Text variant="smallStrong" tone="link">
                    {state.totpEnabled ? t("security.turnOff") : t("security.turnOn")}
                  </Text>
                }
                onPress={() => navigation.navigate("totp", { mode: state.totpEnabled ? "disable" : "enable" })}
              />
              {state.totpEnabled ? (
                <ActionRow
                  icon={ListChecks}
                  tint={c.sun}
                  title={t("security.recoveryCodes")}
                  subtitle={
                    state.recoveryCodesRemaining > 0
                      ? t("security.codesLeft", { count: state.recoveryCodesRemaining })
                      : t("security.noCode")
                  }
                  onPress={newCodes}
                />
              ) : null}
            </>
          )}
        </Section>
        {state && (state.passkeys.length > 0 || canUseBrowserHandoff()) ? (
          <Section label={t("security.passkeys")}>
            {state.passkeys.map((key) => {
              const label = key.label ?? t("security.passkeyLabel");
              return (
                <ActionRow
                  key={key.id}
                  icon={KeyRound}
                  tint={c.violet}
                  title={label}
                  subtitle={key.lastUsedAt ? t("security.usedOn", { date: day(key.lastUsedAt) }) : t("security.addedOn", { date: day(key.createdAt) })}
                  trailing={
                    <Pressable accessibilityRole="button" accessibilityLabel={t("security.remove")} onPress={() => forget(key.id, label)} hitSlop={10}>
                      <Trash2 size={20} color={s.danger} />
                    </Pressable>
                  }
                />
              );
            })}
            {canUseBrowserHandoff() ? (
              <>
                <ActionRow icon={Plus} tint={c.violet} title={t("security.addPasskey")} onPress={addPasskey} />
                <Text variant="small" tone="muted">
                  {t("security.passkeysPhone")}
                </Text>
              </>
            ) : null}
          </Section>
        ) : null}
        <Section label={t("security.lockSection")}>
          <ActionRow
            icon={Lock}
            tint={lock.enabled ? c.mint : s.sunken}
            title={lockTitle}
            subtitle={lock.kind ? t("security.lockHint") : t("security.lockUnavailable")}
            trailing={
              <Toggle
                value={lock.enabled}
                disabled={!lock.kind}
                onValueChange={(on) => void lock.setEnabled(on)}
                accessibilityLabel={lockTitle}
              />
            }
          />
        </Section>
        <Section label={t("security.sessions")}>
          <ActionRow icon={LogOut} danger title={t("security.signOutEverywhere")} subtitle={t("security.sessionsDesc")} onPress={everywhere} />
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { paddingHorizontal: 16, paddingBottom: 48 },
});
