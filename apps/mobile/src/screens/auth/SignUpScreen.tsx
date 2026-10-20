import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Check, Mail, X } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { useApi } from "../../api/useApi";
import { DEFAULT_SERVER } from "../../config";
import { useTranslation } from "../../i18n";
import { passwordLongEnough } from "../../logic/signup";
import type { AuthParams } from "../../navigation/types";
import { FAILURE_TEXT } from "../../session/failureText";
import { AuthFailure, useSession } from "../../session/SessionProvider";
import { hairline, radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { ActionRow } from "../../ui/ActionRow";
import { Banner } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { Screen } from "../../ui/Screen";
import { Text } from "../../ui/Text";
import { TextField } from "../../ui/TextField";
import { AuthTop } from "./AuthTop";
import { hostOf, ServerField } from "./ServerField";

/**
 * Create an account (mockup 05). The server row, as on sign-in; an invitation link, pasted, names the
 * server and the space, fills the address, and spares the confirmation when it was sent to that
 * address. The password rule shown is the server's; it also refuses passwords known from breaches.
 */
export function SignUpScreen() {
  const { getInstanceCapabilities } = useApi();
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const session = useSession();
  const navigation = useNavigation<NativeStackNavigationProp<AuthParams>>();
  const invitation = useRoute<RouteProp<AuthParams, "signUp">>().params?.invitation;
  const server = "server" in session.state ? session.state.server : null;

  const [editing, setEditing] = useState(server === null);
  // Adding another instance from the app: the default one is most likely there already.
  const offered = session.cancel ? null : DEFAULT_SERVER;
  const [serverDraft, setServerDraft] = useState(server ? hostOf(server) : offered ? hostOf(offered) : "");
  const [name, setName] = useState("");
  const [email, setEmail] = useState(invitation?.email ?? "");
  const [password, setPassword] = useState("");
  const [terms, setTerms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AuthFailure | null>(null);
  // Whether the server can send the confirmation at all; unknown until asked.
  const [mail, setMail] = useState<{ server: string; delivers: boolean } | null>(null);

  // An invitation pasted in the meantime may have moved the app to its own server.
  const [shownServer, setShownServer] = useState(server);
  if (server !== shownServer) {
    setShownServer(server);
    setEditing(server === null);
    if (server) setServerDraft(hostOf(server));
  }
  const [shownInvitation, setShownInvitation] = useState(invitation);
  if (invitation !== shownInvitation) {
    setShownInvitation(invitation);
    if (invitation?.email) setEmail(invitation.email);
  }

  useEffect(() => {
    if (!server || editing) return;
    let current = true;
    getInstanceCapabilities().then(
      (caps) => current && setMail({ server, delivers: caps.emailDelivery }),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [server, editing, getInstanceCapabilities]);
  const noMail = mail?.server === server && mail.delivers === false && !invitation;

  const longEnough = passwordLongEnough(password);
  const ready = name.trim() && email.includes("@") && longEnough && terms && !noMail && (server || serverDraft.trim());

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (editing || !server) {
        await session.chooseServer(serverDraft);
        setEditing(false);
      }
      const outcome = await session.register({ name, email, password, invitationToken: invitation?.token });
      if (outcome === "verify") navigation.navigate("verifyEmail");
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
        <Text variant="display">{t("signIn.createAccount")}</Text>
        <Text tone="body">{t("signUp.subtitle")}</Text>
      </View>

      <ServerField server={server} editing={editing} draft={serverDraft} onDraft={setServerDraft} onEdit={() => setEditing(true)} />

      {invitation ? (
        <View style={[styles.invitation, { backgroundColor: s.selected, borderColor: c.line }]}>
          <Mail size={20} color={c.ink} />
          <View style={styles.flex}>
            <Text variant="bodyStrong">{t("invitation.joining", { space: invitation.spaceName })}</Text>
            {invitation.invitedBy ? (
              <Text variant="small" tone="body">
                {t("invitation.invitedBy", { name: invitation.invitedBy })}
              </Text>
            ) : null}
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("invitation.remove")}
            onPress={() => navigation.setParams({ invitation: undefined })}
            hitSlop={10}
          >
            <X size={20} color={c.muted} />
          </Pressable>
        </View>
      ) : (
        <ActionRow
          icon={Mail}
          tint={c.sky}
          title={t("invitation.have")}
          subtitle={t("invitation.haveHint")}
          onPress={() => navigation.navigate("invitationLink")}
        />
      )}

      {noMail ? <Banner tone="danger" text={t("signUp.noMail")} /> : null}

      <TextField
        label={t("signUp.name")}
        placeholder={t("signUp.namePlaceholder")}
        value={name}
        onChangeText={setName}
        textContentType="name"
        autoComplete="name"
      />
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
      <View style={styles.password}>
        <TextField
          label={t("signIn.password")}
          placeholder={t("signUp.passwordPlaceholder")}
          value={password}
          onChangeText={setPassword}
          secret
          textContentType="newPassword"
          autoComplete="new-password"
        />
        <View style={styles.rule}>
          <View style={[styles.tick, longEnough ? { backgroundColor: c.mint, borderColor: c.mint } : { borderColor: c.lineStrong }]}>
            {longEnough ? <Check size={12} color={c.onPastel} strokeWidth={3} /> : null}
          </View>
          <Text variant="small" tone={longEnough ? "strong" : "muted"}>
            {t("signUp.rule")}
          </Text>
        </View>
      </View>

      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: terms }}
        onPress={() => setTerms((v) => !v)}
        style={styles.terms}
      >
        <View style={[styles.box, { borderColor: c.ink }, terms && { backgroundColor: c.acc }]}>
          {terms ? <Check size={16} color={c.onPastel} strokeWidth={3} /> : null}
        </View>
        <Text variant="small" tone="body" style={styles.flex}>
          {t("signUp.terms")}
        </Text>
      </Pressable>

      {error ? <Banner tone="danger" text={t(FAILURE_TEXT[error.code])} /> : null}

      <Button label={t("signUp.submit")} onPress={() => void submit()} busy={busy} disabled={!ready} />

      <View style={styles.signIn}>
        <Text variant="small" tone="body">
          {t("signUp.haveAccount")}
        </Text>
        <Button variant="link" label={t("signIn.submit")} onPress={() => navigation.navigate("signIn")} style={styles.inlineLink} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { gap: 6 },
  flex: { flex: 1, minWidth: 0 },
  invitation: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: radius.m, borderWidth: hairline },
  password: { gap: 10 },
  rule: { flexDirection: "row", alignItems: "center", gap: 8 },
  tick: { width: 18, height: 18, borderRadius: 9, borderWidth: hairline, alignItems: "center", justifyContent: "center" },
  terms: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  box: { width: 24, height: 24, borderRadius: radius.s, borderWidth: 2, alignItems: "center", justifyContent: "center" },
  signIn: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 6 },
  inlineLink: { alignSelf: "center", paddingVertical: 0 },
});
