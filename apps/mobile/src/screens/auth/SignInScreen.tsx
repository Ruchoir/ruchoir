import { Server } from "lucide-react-native";
import * as WebBrowser from "expo-web-browser";
import { useState } from "react";
import { Image, StyleSheet, View } from "react-native";

import { DEFAULT_SERVER } from "../../config";
import { useTranslation } from "../../i18n";
import { FAILURE_TEXT } from "../../session/failureText";
import { AuthFailure, useSession } from "../../session/SessionProvider";
import { hairline, radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { Banner } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { Screen } from "../../ui/Screen";
import { Text } from "../../ui/Text";
import { TextField } from "../../ui/TextField";

/** What the person sees of an origin: its host. */
const hostOf = (origin: string) => origin.replace(/^https:\/\//, "");

/**
 * Sign-in (mockup 04): the server row, the address and the password. The server is changed in place;
 * with none chosen yet, its field is open from the start.
 *
 * Face ID and "sign in with my organisation" are not offered: the first needs a native build (step 6),
 * the second does not exist in the API yet.
 */
export function SignInScreen() {
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const session = useSession();
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

  // The account pages live on the instance's own site until the app has them (step 5).
  const openWeb = () => {
    if (server) void WebBrowser.openBrowserAsync(`${server}/`);
  };

  return (
    <Screen>
      <View style={styles.head}>
        <View style={[styles.markTile, { borderColor: c.lineStrong }]}>
          <Image source={require("../../../assets/mark.png")} style={[styles.mark, { tintColor: c.brand }]} />
        </View>
        <Text variant="display">{t("signIn.submit")}</Text>
      </View>

      {expired && !error ? <Banner tone="danger" text={t("signIn.expired")} /> : null}

      {server && !editing ? (
        <View style={[styles.serverRow, { backgroundColor: s.sunken }]}>
          <Server size={18} color={c.ink} />
          <View style={styles.serverText}>
            <Text variant="tiny" tone="muted">
              {t("signIn.server")}
            </Text>
            <Text variant="bodyStrong" numberOfLines={1}>
              {hostOf(server)}
            </Text>
          </View>
          <Button variant="ghost" size="sm" label={t("signIn.change")} onPress={() => setEditing(true)} />
        </View>
      ) : (
        <TextField
          label={t("signIn.serverField")}
          hint={t("signIn.serverHint")}
          placeholder={t("signIn.serverPlaceholder")}
          value={serverDraft}
          onChangeText={setServerDraft}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          textContentType="URL"
        />
      )}

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
      {server ? <Button variant="link" label={t("signIn.forgot")} onPress={openWeb} /> : null}

      {error ? <Banner tone="danger" text={t(FAILURE_TEXT[error.code])} /> : null}

      <Button
        label={t("signIn.submit")}
        onPress={() => void submit()}
        busy={busy}
        disabled={!email.trim() || !password || (!server && !serverDraft.trim())}
      />

      {server ? (
        <View style={styles.signup}>
          <Text variant="small" tone="body">
            {t("signIn.noAccount")}
          </Text>
          <Button variant="link" label={t("signIn.createAccount")} onPress={openWeb} style={styles.inlineLink} />
        </View>
      ) : null}
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
  serverRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, paddingHorizontal: 12, borderRadius: radius.m },
  serverText: { flex: 1, minWidth: 0 },
  signup: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 6, paddingTop: 4 },
  inlineLink: { alignSelf: "center", paddingVertical: 0 },
});
