/**
 * "Invite someone", for a space's admins: an e-mail address that receives the invitation, or a link
 * to share through the phone's share sheet. Either brings a member, or a guest who sees only the
 * channels they are added to.
 */
import { createInvitation } from "@ruchoir/client";
import { useNavigation } from "@react-navigation/native";
import { CircleCheck, Link } from "lucide-react-native";
import { useState } from "react";
import { ScrollView, Share, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useTranslation } from "../../i18n";
import { isEmail } from "../../logic/email";
import { useSpace } from "../../space/SpaceProvider";
import { hairline, radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { Button } from "../../ui/Button";
import { Segmented } from "../../ui/Segmented";
import { SheetHeader } from "../../ui/SheetHeader";
import { Text } from "../../ui/Text";
import { TextField } from "../../ui/TextField";
import { KeyboardArea } from "../../ui/KeyboardArea";

type Role = "member" | "guest";

export function InviteScreen() {
  const navigation = useNavigation();
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const { current } = useSpace();
  const [role, setRole] = useState<Role>("member");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"email" | "link" | null>(null);
  const [sent, setSent] = useState<{ email: string; url?: string } | null>(null);
  // One link per role, made the first time it is asked for and shared again after.
  const [links, setLinks] = useState<Partial<Record<Role, string>>>({});

  const share = (url: string) => {
    if (!current) return Promise.resolve();
    return Share.share({ message: t("invite.shareMessage", { space: current.name, url }) }).then(() => {});
  };

  const sendEmail = async () => {
    const address = email.trim();
    if (!current) return;
    if (!isEmail(address)) {
      setError(t("invite.invalidEmail"));
      return;
    }
    setBusy("email");
    setError(null);
    try {
      const created = await createInvitation(current.id, { email: address, role });
      setSent({ email: address, url: created.emailed ? undefined : created.url });
      setEmail("");
    } catch {
      setError(t("invite.failed"));
    }
    setBusy(null);
  };

  const shareLink = async () => {
    if (!current) return;
    setBusy("link");
    setError(null);
    try {
      let url = links[role];
      if (!url) {
        url = (await createInvitation(current.id, { role })).url;
        setLinks((prev) => ({ ...prev, [role]: url }));
      }
      await share(url);
    } catch {
      setError(t("invite.failed"));
    }
    setBusy(null);
  };

  return (
    <SafeAreaView edges={["bottom"]} style={[styles.fill, { backgroundColor: c.surface }]}>
      <SheetHeader title={t("newMessage.invite")} onClose={() => navigation.goBack()} />
      <KeyboardArea style={styles.fill}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.form}>
          <View style={styles.block}>
            <Segmented
              style={styles.flush}
              options={[
                { key: "member", label: t("invite.member") },
                { key: "guest", label: t("invite.guest") },
              ]}
              value={role}
              onChange={setRole}
            />
            <Text variant="tiny" tone="muted">
              {role === "member" ? t("invite.memberHint") : t("invite.guestHint")}
            </Text>
          </View>
          <TextField
            label={t("signIn.email")}
            value={email}
            onChangeText={(text) => {
              setEmail(text);
              setError(null);
            }}
            keyboardType="email-address"
            autoCapitalize="none"
            autoComplete="email"
            autoCorrect={false}
            returnKeyType="send"
            onSubmitEditing={() => void sendEmail()}
            error={error ?? undefined}
          />
          <Button label={t("invite.send")} disabled={!email.trim() || busy === "link"} busy={busy === "email"} onPress={() => void sendEmail()} />
          {sent ? (
            <View style={[styles.sent, { backgroundColor: s.successBg }]} accessibilityLiveRegion="polite">
              <CircleCheck size={18} color={s.success} />
              <View style={styles.grow}>
                <Text variant="smallStrong">{t("invite.sent", { email: sent.email })}</Text>
                {sent.url ? (
                  <>
                    <Text variant="tiny" tone="body">
                      {t("invite.notEmailed")}
                    </Text>
                    <Button variant="link" size="sm" label={t("invite.link")} onPress={() => void share(sent.url!)} />
                  </>
                ) : null}
              </View>
            </View>
          ) : null}
          <View style={styles.or}>
            <View style={[styles.rule, { backgroundColor: c.line }]} />
            <Text variant="tiny" tone="muted">
              {t("invite.or")}
            </Text>
            <View style={[styles.rule, { backgroundColor: c.line }]} />
          </View>
          <View style={styles.block}>
            <Button
              variant="secondary"
              label={t("invite.link")}
              icon={<Link size={18} color={c.ink} />}
              busy={busy === "link"}
              disabled={busy === "email"}
              onPress={() => void shareLink()}
            />
            <Text variant="tiny" tone="muted">
              {t("invite.linkHint")}
            </Text>
          </View>
        </ScrollView>
      </KeyboardArea>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  form: { gap: 16, paddingHorizontal: 16, paddingBottom: 24 },
  block: { gap: 8 },
  flush: { marginHorizontal: 0 },
  sent: { flexDirection: "row", gap: 10, padding: 12, borderRadius: radius.m },
  grow: { flex: 1, gap: 4 },
  or: { flexDirection: "row", alignItems: "center", gap: 10 },
  rule: { flex: 1, height: hairline },
});
