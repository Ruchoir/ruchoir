import { isApiError } from "@ruchoir/client";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as Clipboard from "expo-clipboard";
import { ExternalLink } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Linking, StyleSheet, View } from "react-native";
import { SvgXml } from "react-native-svg";

import { useApi } from "../../api/useApi";
import { useTranslation } from "../../i18n";
import { groupedSecret, otpauthSecret } from "../../logic/otpauth";
import { codeComplete, codeDigits } from "../../logic/signup";
import type { RootParams } from "../../navigation/types";
import { fonts } from "../../theme/fonts";
import { radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { Banner } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { feel } from "../../ui/haptics";
import { KeyboardForm } from "../../ui/KeyboardForm";
import { SheetHeader } from "../../ui/SheetHeader";
import { LoadState } from "../../ui/States";
import { Text } from "../../ui/Text";
import { TextField } from "../../ui/TextField";
import { useToast } from "../../ui/Toast";

/**
 * Two-factor authentication, on or off. On: the authenticator app is opened with the account's link
 * (on this phone), or given the key or the QR code (another device), then the six digits it shows;
 * the recovery codes follow at once, as on the web. Off: the password, after a warning.
 */
export function TotpScreen() {
  const { mode } = useRoute<RouteProp<RootParams, "totp">>().params;
  return mode === "enable" ? <TurnOn /> : <TurnOff />;
}

function TurnOn() {
  const { confirmTotp, enrollTotp, generateRecoveryCodes } = useApi();
  const { t } = useTranslation();
  const { c } = useTheme();
  const toast = useToast();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const [enrolment, setEnrolment] = useState<{ otpauthUrl: string; qrSvg: string } | null>(null);
  const [failed, setFailed] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [wrong, setWrong] = useState(false);

  useEffect(() => {
    let current = true;
    enrollTotp().then(
      (next) => current && setEnrolment(next),
      () => current && setFailed(true),
    );
    return () => {
      current = false;
    };
  }, [enrollTotp]);

  const secret = enrolment ? otpauthSecret(enrolment.otpauthUrl) : null;

  const finish = async () => {
    setBusy(true);
    setWrong(false);
    try {
      await confirmTotp(code);
    } catch {
      feel("failure");
      setWrong(true);
      setBusy(false);
      return;
    }
    toast(t("security.mfaEnabled"), "success");
    // Straight to the codes: they can only be shown now, and they are what saves a lost phone.
    const codes = await generateRecoveryCodes().catch(() => null);
    if (codes) navigation.replace("recoveryCodes", { codes });
    else navigation.goBack();
  };

  return (
    <View style={[styles.fill, { backgroundColor: c.bg }]}>
      <KeyboardForm
        contentContainerStyle={styles.content}
        footer={
          enrolment ? (
            <View style={styles.footer}>
              <Button label={t("security.turnOn")} onPress={() => void finish()} busy={busy} disabled={!codeComplete(code)} />
            </View>
          ) : null
        }
      >
        <SheetHeader title={t("security.setupTotp")} onClose={() => navigation.goBack()} />
        <View style={styles.pad}>
          {!enrolment ? (
            failed ? (
              <Banner tone="danger" text={t("security.setupFailed")} />
            ) : (
              <LoadState error={null} onRetry={() => {}} />
            )
          ) : (
            <>
              <Text tone="body">{t("security.setupPhone")}</Text>
              <Button
                variant="secondary"
                label={t("security.openAuthenticator")}
                icon={<ExternalLink size={18} color={c.ink} />}
                onPress={() => void Linking.openURL(enrolment.otpauthUrl).catch(() => toast(t("security.noAuthenticator"), "failure"))}
              />
              {secret ? (
                <View style={[styles.secret, { backgroundColor: c.surface, borderColor: c.line }]}>
                  <Text variant="small" tone="muted">
                    {t("security.key")}
                  </Text>
                  <Text variant="bodyStrong" selectable style={styles.mono}>
                    {groupedSecret(secret)}
                  </Text>
                  <Button
                    variant="link"
                    label={t("security.copyKey")}
                    onPress={() => void Clipboard.setStringAsync(secret).then(() => toast(t("security.keyCopied")))}
                  />
                </View>
              ) : null}
              <Text variant="small" tone="muted">
                {t("security.otherDevice")}
              </Text>
              <View style={styles.qr}>
                <SvgXml xml={enrolment.qrSvg} width={176} height={176} />
              </View>
              <TextField
                label={t("security.sixDigits")}
                value={code}
                onChangeText={(value) => {
                  setCode(codeDigits(value));
                  setWrong(false);
                }}
                keyboardType="number-pad"
                textContentType="oneTimeCode"
                maxLength={6}
                error={wrong ? t("security.wrongTotpCode") : undefined}
              />
            </>
          )}
        </View>
      </KeyboardForm>
    </View>
  );
}

function TurnOff() {
  const { disableTotp } = useApi();
  const { t } = useTranslation();
  const { c } = useTheme();
  const toast = useToast();
  const navigation = useNavigation();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"wrong" | "other" | null>(null);

  const turnOff = async () => {
    setBusy(true);
    setError(null);
    try {
      await disableTotp(password);
      toast(t("security.mfaDisabled"), "success");
      navigation.goBack();
    } catch (err) {
      feel("failure");
      setError(isApiError(err, 401) ? "wrong" : "other");
      setBusy(false);
    }
  };

  return (
    <View style={[styles.fill, { backgroundColor: c.bg }]}>
      <KeyboardForm
        contentContainerStyle={styles.content}
        footer={
          <View style={styles.footer}>
            <Button label={t("security.turnOff")} onPress={() => void turnOff()} busy={busy} disabled={!password} />
          </View>
        }
      >
        <SheetHeader title={t("security.disableTitle")} onClose={() => navigation.goBack()} />
        <View style={styles.pad}>
          <Text tone="body">{t("security.passwordOnlyWarning")}</Text>
          <TextField
            label={t("signIn.passwordPlaceholder")}
            value={password}
            onChangeText={setPassword}
            secret
            textContentType="password"
            autoComplete="current-password"
            error={error === "wrong" ? t("security.wrongPassword") : error ? t("auth.error.unknown") : undefined}
          />
        </View>
      </KeyboardForm>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { paddingBottom: 24 },
  pad: { paddingHorizontal: 20, gap: 16 },
  footer: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 12 },
  secret: { gap: 4, padding: 14, borderRadius: radius.m, borderWidth: 1.5 },
  mono: { fontFamily: fonts.monoSemibold, letterSpacing: 1 },
  qr: { alignSelf: "center", padding: 12, borderRadius: radius.m, backgroundColor: "#ffffff" },
});
