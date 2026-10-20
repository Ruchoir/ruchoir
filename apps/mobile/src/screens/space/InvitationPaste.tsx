import { createClient, isApiError } from "@ruchoir/client";
import * as Clipboard from "expo-clipboard";
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { useApi } from "../../api/useApi";
import { key, useTranslation } from "../../i18n";
import { parseInvitationLink } from "../../logic/invitationLink";
import type { InvitationChoice } from "../../navigation/types";
import { FAILURE_TEXT } from "../../session/failureText";
import { AuthFailure, useSession } from "../../session/SessionProvider";
import { Banner } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { TextField } from "../../ui/TextField";

const PASTE_TEXT = {
  unreadable: key("invitation.unreadable"),
  expired: key("invitation.expired"),
};

type Failure = { kind: keyof typeof PASTE_TEXT } | { kind: "auth"; failure: AuthFailure };

/**
 * Paste an invitation link, check it, and see what it leads to. Before sign-in (`switchServer`) a
 * link from another server moves the app to that server first, which is how someone invited learns
 * where their team is. Once signed in, a link from another server is checked with that server and
 * comes back with its `origin`: joining it then goes through that instance (ADR 0007).
 */
export function InvitationPaste({
  switchServer,
  onResolved,
}: {
  switchServer: boolean;
  onResolved: (choice: InvitationChoice) => void;
}) {
  const { previewInvitation } = useApi();
  const { t } = useTranslation();
  const session = useSession();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  const resolve = async (input: string) => {
    const server = "server" in session.state ? session.state.server : null;
    const link = parseInvitationLink(input, server);
    if (!link) return setFailure({ kind: "unreadable" });
    setBusy(true);
    setFailure(null);
    try {
      const elsewhere = link.origin !== server && !switchServer;
      if (link.origin !== server && switchServer) await session.chooseServer(link.origin);
      // The preview needs no session: another instance's is asked of that instance directly.
      const preview = elsewhere ? await createClient({ baseUrl: link.origin }).previewInvitation(link.token) : await previewInvitation(link.token);
      onResolved({
        token: link.token,
        spaceName: preview.spaceName,
        invitedBy: preview.invitedBy,
        email: preview.email,
        origin: elsewhere ? link.origin : undefined,
      });
    } catch (err) {
      if (err instanceof AuthFailure) setFailure({ kind: "auth", failure: err });
      else if (isApiError(err, 404)) setFailure({ kind: "expired" });
      else setFailure({ kind: "auth", failure: new AuthFailure(isApiError(err) ? "unknown" : "unreachable") });
    } finally {
      setBusy(false);
    }
  };

  const paste = async () => {
    const pasted = (await Clipboard.getStringAsync().catch(() => "")).trim();
    if (!pasted) return;
    setText(pasted);
    void resolve(pasted);
  };

  return (
    <View style={styles.box}>
      <TextField
        label={t("invitation.field")}
        placeholder={t("invitation.placeholder")}
        value={text}
        onChangeText={(value) => {
          setText(value);
          setFailure(null);
        }}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        onSubmitEditing={() => void resolve(text)}
      />
      {failure ? (
        <Banner
          tone="danger"
          text={failure.kind === "auth" ? t(FAILURE_TEXT[failure.failure.code]) : t(PASTE_TEXT[failure.kind])}
        />
      ) : null}
      <View style={styles.row}>
        <Button variant="secondary" label={t("invitation.paste")} onPress={() => void paste()} style={styles.flex} />
        <Button label={t("invitation.check")} onPress={() => void resolve(text)} busy={busy} disabled={!text.trim()} style={styles.flex} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: 14 },
  row: { flexDirection: "row", gap: 10 },
  flex: { flex: 1 },
});
