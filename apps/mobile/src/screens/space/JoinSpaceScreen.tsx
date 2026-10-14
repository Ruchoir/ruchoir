import { acceptInvitation, createSpace, type Workspace } from "@ruchoir/client";
import { NavigationContext } from "@react-navigation/native";
import { Mail, Plus, type LucideIcon } from "lucide-react-native";
import { useContext, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useTranslation } from "../../i18n";
import type { InvitationChoice } from "../../navigation/types";
import { useSession } from "../../session/SessionProvider";
import { useSpace } from "../../space/SpaceProvider";
import { hairline, radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { Banner } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { KeyboardForm } from "../../ui/KeyboardForm";
import { SheetHeader } from "../../ui/SheetHeader";
import { Text } from "../../ui/Text";
import { TextField } from "../../ui/TextField";
import { InvitationPaste } from "./InvitationPaste";

type Mode = "join" | "create";

/**
 * Join or create a space (mockup 07). Shown instead of the tabs to an account in no space yet (the
 * `gate`, with a way to sign out), and as a modal from "Switch space". Either way the app then opens
 * in that space.
 */
export function JoinSpaceScreen({ gate = false }: { gate?: boolean }) {
  const { t } = useTranslation();
  const { c } = useTheme();
  const { spaces, select } = useSpace();
  const session = useSession();
  // The gate is drawn before any navigator exists: no navigation there, and nothing to go back to.
  const navigation = useContext(NavigationContext);
  const [mode, setMode] = useState<Mode>("join");
  const [invitation, setInvitation] = useState<InvitationChoice | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const enter = (space: Workspace) => {
    select(space.id);
    spaces.reload();
    if (!gate) navigation?.goBack();
  };

  const join = async () => {
    if (!invitation) return;
    setBusy(true);
    setFailed(false);
    try {
      enter(await acceptInvitation(invitation.token));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    setBusy(true);
    setFailed(false);
    try {
      enter(await createSpace(name.trim()));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const option = (key: Mode, icon: LucideIcon, tint: string, title: string, text: string) => {
    const on = mode === key;
    const Icon = icon;
    return (
      <Pressable
        accessibilityRole="radio"
        accessibilityState={{ selected: on }}
        onPress={() => {
          setMode(key);
          setFailed(false);
        }}
        style={[
          styles.option,
          { backgroundColor: c.surface, borderColor: on ? c.ink : c.lineStrong, shadowColor: c.ink },
          on && styles.lifted,
        ]}
      >
        <View style={[styles.tile, { backgroundColor: tint }]}>
          <Icon size={20} color={c.onPastel} />
        </View>
        <View style={styles.flex}>
          <Text variant="bodyStrong">{title}</Text>
          <Text variant="small" tone="body">
            {text}
          </Text>
        </View>
      </Pressable>
    );
  };

  const footer =
    mode === "create" ? (
      <View style={styles.footer}>
        {failed ? <Banner tone="danger" text={t("joinSpace.createFailed")} /> : null}
        <Button label={t("joinSpace.create")} onPress={() => void create()} busy={busy} disabled={!name.trim()} />
      </View>
    ) : invitation ? (
      <View style={styles.footer}>
        {failed ? <Banner tone="danger" text={t("joinSpace.joinFailed")} /> : null}
        <Button label={t("joinSpace.join", { space: invitation.spaceName })} onPress={() => void join()} busy={busy} />
      </View>
    ) : null;

  const body = (
    <KeyboardForm contentContainerStyle={styles.content} footer={footer}>
      {gate ? null : <SheetHeader title={t("joinSpace.modalTitle")} onClose={() => navigation?.goBack()} />}
      <View style={styles.pad}>
        {gate ? (
          <View style={styles.head}>
            <Text variant="display">{t("joinSpace.title")}</Text>
            <Text tone="body">{t("joinSpace.subtitle")}</Text>
          </View>
        ) : null}
        {option("join", Mail, c.sky, t("joinSpace.joinTitle"), t("joinSpace.joinText"))}
        {option("create", Plus, c.mint, t("joinSpace.createTitle"), t("joinSpace.createText"))}
        {mode === "join" ? (
          invitation ? (
            <View style={[styles.preview, { borderColor: c.line, backgroundColor: c.surface }]}>
              <Text variant="bodyStrong">{invitation.spaceName}</Text>
              {invitation.invitedBy ? (
                <Text variant="small" tone="body">
                  {t("invitation.invitedBy", { name: invitation.invitedBy })}
                </Text>
              ) : null}
              <Button variant="link" label={t("joinSpace.otherLink")} onPress={() => setInvitation(null)} />
            </View>
          ) : (
            <InvitationPaste switchServer={false} onResolved={setInvitation} />
          )
        ) : (
          <TextField
            label={t("joinSpace.name")}
            hint={t("joinSpace.nameHint")}
            placeholder={t("joinSpace.namePlaceholder")}
            value={name}
            onChangeText={setName}
            autoFocus
            onSubmitEditing={() => name.trim() && void create()}
          />
        )}
        {gate ? <Button variant="ghost" label={t("account.signOut")} onPress={() => void session.signOut()} /> : null}
      </View>
    </KeyboardForm>
  );

  if (!gate) return <View style={[styles.fill, { backgroundColor: c.bg }]}>{body}</View>;
  return (
    <SafeAreaView style={[styles.fill, { backgroundColor: c.bg }]} edges={["top"]}>
      {body}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  flex: { flex: 1, minWidth: 0 },
  content: { paddingBottom: 24 },
  pad: { paddingHorizontal: 20, paddingTop: 16, gap: 16 },
  head: { gap: 6, paddingTop: 8, paddingBottom: 4 },
  option: { flexDirection: "row", alignItems: "center", gap: 14, padding: 16, borderRadius: radius.l, borderWidth: hairline },
  lifted: { borderWidth: 2, shadowOffset: { width: 4, height: 4 }, shadowOpacity: 1, shadowRadius: 0, elevation: 4 },
  tile: { width: 40, height: 40, borderRadius: radius.m, alignItems: "center", justifyContent: "center" },
  preview: { gap: 4, padding: 16, borderRadius: radius.m, borderWidth: hairline },
  footer: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 12, gap: 10 },
});
