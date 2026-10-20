/**
 * "Invite someone from outside" into one channel: an address that receives a single-use invitation,
 * as a guest who sees this channel and nothing else of the space. For whoever runs the channel (its
 * owner, a moderator, the space's administrators), which the API checks.
 */
import { inviteToChannel, isApiError } from "@ruchoir/client";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import { useState } from "react";
import { Share, StyleSheet, View } from "react-native";

import { useTranslation } from "../../i18n";
import { isEmail } from "../../logic/email";
import type { RootParams } from "../../navigation/types";
import { hairline } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { Button } from "../../ui/Button";
import { feel } from "../../ui/haptics";
import { KeyboardForm } from "../../ui/KeyboardForm";
import { SheetHeader } from "../../ui/SheetHeader";
import { Text } from "../../ui/Text";
import { TextField } from "../../ui/TextField";
import { useToast } from "../../ui/Toast";

export function ChannelInviteScreen() {
  const { params } = useRoute<RouteProp<RootParams, "channelInvite">>();
  const navigation = useNavigation();
  const { t } = useTranslation();
  const { c } = useTheme();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const send = async () => {
    if (!isEmail(email)) {
      setError(t("invite.invalidEmail"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await inviteToChannel(params.channelId, email.trim());
      navigation.goBack();
      if (created.emailed) {
        feel("success");
        toast(t("invite.sent", { email: email.trim() }), "success");
      } else {
        // The mail did not leave: the link is the way in, handed over through the share sheet.
        toast(t("invite.notEmailed"), "failure");
        void Share.share({ message: created.url });
      }
    } catch (err) {
      feel("failure");
      setError(isApiError(err, 403) ? t("channelInvite.forbidden") : isApiError(err, 400) ? t("channelInvite.refused") : t("invite.failed"));
      setBusy(false);
    }
  };

  return (
    <View style={[styles.fill, { backgroundColor: c.surface }]}>
      <SheetHeader title={t("channelInvite.title", { name: params.title })} onClose={() => navigation.goBack()} />
      <KeyboardForm
        keyboardDismissMode="on-drag"
        contentContainerStyle={styles.form}
        footer={
          <View style={[styles.foot, { borderTopColor: c.line, backgroundColor: c.surface }]}>
            <Button label={t("invite.send")} disabled={!email.trim()} busy={busy} onPress={() => void send()} />
          </View>
        }
      >
        <View style={styles.gutter}>
          <Text tone="body">{t("channelInvite.hint")}</Text>
        </View>
        <View style={styles.gutter}>
          <TextField
            label={t("signIn.email")}
            value={email}
            onChangeText={(v) => {
              setEmail(v);
              setError(null);
            }}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            returnKeyType="send"
            onSubmitEditing={() => void send()}
            error={error ?? undefined}
          />
        </View>
      </KeyboardForm>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  form: { gap: 16, paddingTop: 8, paddingBottom: 24 },
  gutter: { paddingHorizontal: 16 },
  foot: { gap: 8, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, borderTopWidth: hairline },
});
