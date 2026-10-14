import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Mail } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { AppState, Linking, Platform, StyleSheet, View } from "react-native";

import { useNow } from "../../data/useNow";
import { useTranslation } from "../../i18n";
import { codeComplete, codeDigits } from "../../logic/signup";
import type { AuthParams } from "../../navigation/types";
import { FAILURE_TEXT } from "../../session/failureText";
import { AuthFailure, useSession } from "../../session/SessionProvider";
import { useTheme } from "../../theme/useTheme";
import { Banner } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { Screen } from "../../ui/Screen";
import { Text } from "../../ui/Text";
import { TextField } from "../../ui/TextField";
import { Sticker } from "../welcome/Sticker";
import { AuthTop } from "./AuthTop";

/** Seconds between two links asked for from this screen. */
const RESEND_EVERY = 60;

/**
 * Check your e-mails (mockup 06). The link opens the instance's site, which confirms the address;
 * coming back to the app, it signs in by itself with what was typed at sign-up (kept in memory only).
 * The six-digit code from the same e-mail does it from here, for a mailbox read elsewhere.
 */
export function VerifyEmailScreen() {
  const { t } = useTranslation();
  const { c } = useTheme();
  const session = useSession();
  const navigation = useNavigation<NativeStackNavigationProp<AuthParams>>();
  const email = session.pendingSignUp?.email;
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AuthFailure | null>(null);
  const [resent, setResent] = useState(false);
  const [sentAt, setSentAt] = useState(() => Date.now());
  const now = useNow(1000);
  const wait = Math.max(0, RESEND_EVERY - Math.floor((now - sentAt) / 1000));

  // Back from the mailbox (or from the site the link opened): try the account again.
  const retry = useRef(session.retryPendingSignIn);
  useEffect(() => {
    retry.current = session.retryPendingSignIn;
  });
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void retry.current();
    });
    return () => subscription.remove();
  }, []);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await session.confirmCode(code);
    } catch (err) {
      setError(err instanceof AuthFailure ? err : new AuthFailure("unknown"));
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    setError(null);
    try {
      await session.resendVerification();
      setResent(true);
      setSentAt(Date.now());
    } catch (err) {
      setError(err instanceof AuthFailure ? err : new AuthFailure("unknown"));
    }
  };

  const leave = () => {
    session.forgetPendingSignUp();
    navigation.goBack();
  };

  return (
    <Screen>
      <AuthTop onBack={leave} />
      <View style={styles.head}>
        <Sticker icon={Mail} color={c.sky} size={96} rotate={-4} style={styles.sticker} />
        <Text variant="title" style={styles.center}>
          {t("verify.title")}
        </Text>
        <Text tone="body" style={styles.center}>
          {t("verify.sentTo")}
        </Text>
        <Text variant="bodyStrong" style={styles.center}>
          {email}
        </Text>
        <Text tone="body" style={styles.center}>
          {t("verify.instructions")}
        </Text>
      </View>

      {Platform.OS === "ios" ? (
        <Button
          label={t("verify.openMail")}
          icon={<Mail size={18} color={c.onInk} />}
          onPress={() => void Linking.openURL("message:").catch(() => {})}
        />
      ) : null}

      <TextField
        label={t("verify.codeLabel")}
        value={code}
        onChangeText={(value) => {
          setCode(codeDigits(value));
          setError(null);
        }}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        maxLength={6}
        onSubmitEditing={() => codeComplete(code) && void confirm()}
      />
      {error ? (
        <Banner tone="danger" text={error.code === "invalid_code" ? t("verify.codeWrong") : t(FAILURE_TEXT[error.code])} />
      ) : resent ? (
        <Banner tone="success" text={t("verify.resent")} />
      ) : null}
      <Button variant="secondary" label={t("verify.codeSubmit")} onPress={() => void confirm()} busy={busy} disabled={!codeComplete(code)} />

      <Button
        variant="link"
        label={wait > 0 ? t("verify.resendIn", { seconds: wait }) : t("verify.resend")}
        onPress={() => void resend()}
        disabled={wait > 0}
        style={styles.centered}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { alignItems: "center", gap: 8, paddingTop: 8 },
  sticker: { marginBottom: 16 },
  center: { textAlign: "center" },
  centered: { alignSelf: "center" },
});
