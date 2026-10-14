import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useState } from "react";
import { Image, StyleSheet, View } from "react-native";

import { DEFAULT_SERVER } from "../../config";
import { useTranslation } from "../../i18n";
import type { AuthParams } from "../../navigation/types";
import { FAILURE_TEXT } from "../../session/failureText";
import { AuthFailure, useSession } from "../../session/SessionProvider";
import { hairline, radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { Banner } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { Screen } from "../../ui/Screen";
import { Text } from "../../ui/Text";
import { TextField } from "../../ui/TextField";
import { AuthTop } from "./AuthTop";
import { hostOf, ServerField } from "./ServerField";

/**
 * Sign-in (mockup 04): the server row, the address and the password. The server is changed in place;
 * with none chosen yet, its field is open from the start.
 *
 * Face ID and "sign in with my organisation" are not offered: the first needs a native build (step 6),
 * the second does not exist in the API yet. "Create an account" and "Forgot password" open their own
 * screens.
 */
export function SignInScreen() {
  const { t } = useTranslation();
  const { c } = useTheme();
  const session = useSession();
  const navigation = useNavigation<NativeStackNavigationProp<AuthParams>>();
  const server = "server" in session.state ? session.state.server : null;
  const expired = session.state.kind === "signedOut" && session.state.reason === "expired";

  const [editing, setEditing] = useState(server === null);
  const [serverDraft, setServerDraft] = useState(server ? hostOf(server) : (DEFAULT_SERVER ? hostOf(DEFAULT_SERVER) : ""));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AuthFailure | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (editing || !server) {
        await session.chooseServer(serverDraft);
        setEditing(false);
      }
      await session.signIn(email, password);
    } catch (err) {
      setError(err instanceof AuthFailure ? err : new AuthFailure("unknown"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <AuthTop />
      <View style={styles.head}>
        <View style={[styles.markTile, { borderColor: c.lineStrong }]}>
          <Image source={require("../../../assets/mark.png")} style={[styles.mark, { tintColor: c.brand }]} />
        </View>
        <Text variant="display">{t("signIn.submit")}</Text>
      </View>

      {expired && !error ? <Banner tone="danger" text={t("signIn.expired")} /> : null}

      <ServerField server={server} editing={editing} draft={serverDraft} onDraft={setServerDraft} onEdit={() => setEditing(true)} />

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
      <TextField
        label={t("signIn.password")}
        placeholder={t("signIn.passwordPlaceholder")}
        value={password}
        onChangeText={setPassword}
        secret
        textContentType="password"
        autoComplete="current-password"
        onSubmitEditing={() => void submit()}
      />
      <Button variant="link" label={t("signIn.forgot")} onPress={() => navigation.navigate("forgotPassword", { email: email.trim() || undefined })} />

      {error ? <Banner tone="danger" text={t(FAILURE_TEXT[error.code])} /> : null}

      <Button
        label={t("signIn.submit")}
        onPress={() => void submit()}
        busy={busy}
        disabled={!email.trim() || !password || (!server && !serverDraft.trim())}
      />

      <View style={styles.signup}>
        <Text variant="small" tone="body">
          {t("signIn.noAccount")}
        </Text>
        <Button variant="link" label={t("signIn.createAccount")} onPress={() => navigation.navigate("signUp")} style={styles.inlineLink} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { gap: 14, paddingTop: 12 },
  markTile: {
    width: 56,
    height: 56,
    borderRadius: radius.l,
    borderWidth: hairline,
    backgroundColor: "#f7f3ed",
    alignItems: "center",
    justifyContent: "center",
  },
  mark: { width: 34, height: 34, marginTop: 4 },
  signup: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 6, paddingTop: 4 },
  inlineLink: { alignSelf: "center", paddingVertical: 0 },
});
