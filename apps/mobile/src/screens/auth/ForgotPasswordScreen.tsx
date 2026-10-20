import { isApiError } from "@ruchoir/client";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";

import { useApi } from "../../api/useApi";
import { useTranslation } from "../../i18n";
import { passwordLongEnough } from "../../logic/signup";
import type { AuthParams } from "../../navigation/types";
import { useSession } from "../../session/SessionProvider";
import { Banner } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { Screen } from "../../ui/Screen";
import { Text } from "../../ui/Text";
import { TextField } from "../../ui/TextField";
import { AuthTop } from "./AuthTop";

type Outcome = "sent" | "recovered" | null;

/**
 * Forgot password, as the web's screen: a link by e-mail (it opens the site to choose the new
 * password), or a recovery code that sets it from here. A server that sends no e-mail offers the code
 * only. Neither answer says whether the address has an account.
 */
export function ForgotPasswordScreen() {
  const { getInstanceCapabilities, requestPasswordReset, resetPasswordWithRecoveryCode } = useApi();
  const { t } = useTranslation();
  const { state } = useSession();
  const navigation = useNavigation<NativeStackNavigationProp<AuthParams>>();
  const server = "server" in state ? state.server : null;
  const [email, setEmail] = useState(useRoute<RouteProp<AuthParams, "forgotPassword">>().params?.email ?? "");
  const [recovery, setRecovery] = useState(false);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<"code" | "network" | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [noMail, setNoMail] = useState(false);

  useEffect(() => {
    if (!server) return;
    let current = true;
    getInstanceCapabilities().then(
      (caps) => current && setNoMail(!caps.emailDelivery),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [getInstanceCapabilities, server]);
  const byCode = recovery || noMail;

  const submit = async () => {
    setBusy(true);
    setFailed(null);
    try {
      if (byCode) {
        await resetPasswordWithRecoveryCode(email.trim(), code.trim(), password);
        setOutcome("recovered");
      } else {
        await requestPasswordReset(email.trim());
        setOutcome("sent");
      }
    } catch (err) {
      setFailed(isApiError(err) ? "code" : "network");
    } finally {
      setBusy(false);
    }
  };

  if (outcome) {
    return (
      <Screen>
        <AuthTop />
        <View style={styles.head}>
          <Text variant="display">{outcome === "sent" ? t("verify.title") : t("forgot.recoveredTitle")}</Text>
          <Text tone="body">{outcome === "sent" ? t("forgot.sentBody", { email: email.trim() }) : t("forgot.recovered")}</Text>
        </View>
        <Button label={t("signIn.submit")} onPress={() => navigation.popTo("signIn")} />
      </Screen>
    );
  }

  return (
    <Screen>
      <AuthTop />
      <View style={styles.head}>
        <Text variant="display">{t("forgot.title")}</Text>
        <Text tone="body">{byCode ? t("forgot.recoveryIntro") : t("forgot.intro")}</Text>
      </View>
      {noMail ? <Banner tone="danger" text={t("forgot.noMail")} /> : null}
      <TextField
        label={t("signIn.email")}
        placeholder={t("signIn.emailPlaceholder")}
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        textContentType="username"
        autoComplete="email"
      />
      {byCode ? (
        <>
          <TextField
            label={t("mfa.recoveryField")}
            value={code}
            onChangeText={setCode}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TextField
            label={t("forgot.newPassword")}
            value={password}
            onChangeText={setPassword}
            secret
            textContentType="newPassword"
            autoComplete="new-password"
            hint={t("signUp.rule")}
          />
        </>
      ) : null}
      {failed ? <Banner tone="danger" text={failed === "code" ? t("forgot.failed") : t("auth.error.unreachable")} /> : null}
      <Button
        label={byCode ? t("forgot.recoverySubmit") : t("forgot.send")}
        onPress={() => void submit()}
        busy={busy}
        disabled={!email.includes("@") || (byCode && (!code.trim() || !passwordLongEnough(password)))}
      />
      {noMail ? null : (
        <Button
          variant="link"
          label={recovery ? t("forgot.useLink") : t("forgot.useRecovery")}
          onPress={() => {
            setRecovery((v) => !v);
            setFailed(null);
          }}
          style={styles.centered}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { gap: 8 },
  centered: { alignSelf: "center" },
});
