import { useNavigation } from "@react-navigation/native";
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { useTranslation } from "../../i18n";
import { passwordLongEnough } from "../../logic/signup";
import { FAILURE_TEXT } from "../../session/failureText";
import { AuthFailure, useSession } from "../../session/SessionProvider";
import { useTheme } from "../../theme/useTheme";
import { Banner } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { KeyboardForm } from "../../ui/KeyboardForm";
import { SheetHeader } from "../../ui/SheetHeader";
import { Text } from "../../ui/Text";
import { TextField } from "../../ui/TextField";
import { useToast } from "../../ui/Toast";

/**
 * Change the password: the current one, then the new. Every session ends, this one included, and the
 * app signs straight back in with the new password.
 */
export function ChangePasswordScreen() {
  const { t } = useTranslation();
  const { c } = useTheme();
  const toast = useToast();
  const session = useSession();
  const navigation = useNavigation();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AuthFailure | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await session.changePassword(current, next);
      toast(t("security.passwordChanged"));
      if (navigation.canGoBack()) navigation.goBack();
    } catch (err) {
      setError(err instanceof AuthFailure ? err : new AuthFailure("unknown"));
      setBusy(false);
    }
  };

  return (
    <View style={[styles.fill, { backgroundColor: c.bg }]}>
      <KeyboardForm
        contentContainerStyle={styles.content}
        footer={
          <View style={styles.footer}>
            <Button
              label={t("security.changePassword")}
              onPress={() => void save()}
              busy={busy}
              disabled={!current || !passwordLongEnough(next)}
            />
          </View>
        }
      >
        <SheetHeader title={t("security.changePassword")} onClose={() => navigation.goBack()} />
        <View style={styles.pad}>
          <Text tone="body">{t("security.allSessionsClosed")}</Text>
          <TextField
            label={t("security.currentPassword")}
            value={current}
            onChangeText={setCurrent}
            secret
            textContentType="password"
            autoComplete="current-password"
          />
          <TextField
            label={t("forgot.newPassword")}
            value={next}
            onChangeText={setNext}
            secret
            textContentType="newPassword"
            autoComplete="new-password"
            hint={t("signUp.rule")}
          />
          {error ? (
            <Banner
              tone="danger"
              text={error.code === "invalid_credentials" ? t("security.wrongCurrentPassword") : t(FAILURE_TEXT[error.code])}
            />
          ) : null}
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
});
