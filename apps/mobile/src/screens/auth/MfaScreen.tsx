import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { useTranslation } from "../../i18n";
import { FAILURE_TEXT } from "../../session/failureText";
import { AuthFailure, useSession } from "../../session/SessionProvider";
import { Banner } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { Screen } from "../../ui/Screen";
import { Text } from "../../ui/Text";
import { TextField } from "../../ui/TextField";

/**
 * The second factor: the authenticator's six digits, or a recovery code; and a passkey, through the
 * instance's own web page (`auth/browser.ts`), when the account has one.
 */
export function MfaScreen() {
  const { t } = useTranslation();
  const session = useSession();
  const methods = session.state.kind === "mfa" ? session.state.methods : [];
  const typed = methods.includes("totp") || methods.includes("recovery");
  const [method, setMethod] = useState<"totp" | "recovery">(methods.includes("totp") ? "totp" : "recovery");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"code" | "passkey" | null>(null);
  const [error, setError] = useState<AuthFailure | null>(null);
  const other = method === "totp" ? "recovery" : "totp";

  const attempt = async (which: "code" | "passkey", work: () => Promise<unknown>) => {
    setBusy(which);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(err instanceof AuthFailure ? err : new AuthFailure("unknown"));
    } finally {
      setBusy(null);
    }
  };

  const passkey = methods.includes("passkey") ? (
    <View style={styles.passkey}>
      <Button
        variant={typed ? "secondary" : "primary"}
        label={t("mfa.usePasskey")}
        busy={busy === "passkey"}
        disabled={busy === "code"}
        onPress={() => void attempt("passkey", session.signInInBrowser)}
      />
      <Text variant="small" tone="muted">
        {t("mfa.passkeyHint")}
      </Text>
    </View>
  ) : null;

  return (
    <Screen>
      <View style={styles.head}>
        <Text variant="display">{t("mfa.title")}</Text>
        <Text tone="body">{!typed ? t("mfa.passkeyIntro") : method === "totp" ? t("mfa.totpIntro") : t("mfa.recoveryIntro")}</Text>
      </View>
      {typed ? (
        <>
          <TextField
            label={method === "totp" ? t("mfa.totpField") : t("mfa.recoveryField")}
            value={code}
            onChangeText={setCode}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType={method === "totp" ? "number-pad" : "default"}
            textContentType={method === "totp" ? "oneTimeCode" : "none"}
            onSubmitEditing={() => void attempt("code", () => session.verify(method, code))}
          />
          {error ? <Banner tone="danger" text={t(FAILURE_TEXT[error.code])} /> : null}
          <Button
            label={t("mfa.submit")}
            onPress={() => void attempt("code", () => session.verify(method, code))}
            busy={busy === "code"}
            disabled={!code.trim() || busy === "passkey"}
          />
          {methods.includes(other) ? (
            <Button
              variant="link"
              label={other === "totp" ? t("mfa.useTotp") : t("mfa.useRecovery")}
              onPress={() => {
                setMethod(other);
                setCode("");
                setError(null);
              }}
            />
          ) : null}
          {passkey}
        </>
      ) : (
        <>
          {error ? <Banner tone="danger" text={t(FAILURE_TEXT[error.code])} /> : null}
          {passkey}
        </>
      )}
      <Button variant="ghost" label={t("mfa.back")} onPress={() => void session.signOut()} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { gap: 8, paddingTop: 24 },
  passkey: { gap: 6, paddingTop: 8 },
});
