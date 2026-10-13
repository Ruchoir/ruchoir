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

/** The second factor: the authenticator's six digits, or a recovery code. */
export function MfaScreen() {
  const { t } = useTranslation();
  const session = useSession();
  const methods = session.state.kind === "mfa" ? session.state.methods : [];
  const [method, setMethod] = useState<"totp" | "recovery">(methods.includes("totp") ? "totp" : "recovery");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AuthFailure | null>(null);
  const other = method === "totp" ? "recovery" : "totp";

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await session.verify(method, code);
    } catch (err) {
      setError(err instanceof AuthFailure ? err : new AuthFailure("unknown"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <View style={styles.head}>
        <Text variant="display">{t("mfa.title")}</Text>
        <Text tone="body">{method === "totp" ? t("mfa.totpIntro") : t("mfa.recoveryIntro")}</Text>
      </View>
      <TextField
        label={method === "totp" ? t("mfa.totpField") : t("mfa.recoveryField")}
        value={code}
        onChangeText={setCode}
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={method === "totp" ? "number-pad" : "default"}
        textContentType={method === "totp" ? "oneTimeCode" : "none"}
        onSubmitEditing={() => void submit()}
      />
      {error ? <Banner tone="danger" text={t(FAILURE_TEXT[error.code])} /> : null}
      <Button label={t("mfa.submit")} onPress={() => void submit()} busy={busy} disabled={!code.trim()} />
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
      <Button variant="ghost" label={t("mfa.back")} onPress={() => void session.signOut()} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { gap: 8, paddingTop: 24 },
});
