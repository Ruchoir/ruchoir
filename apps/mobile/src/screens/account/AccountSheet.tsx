import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Bookmark, CircleCheck, LifeBuoy, LogOut, Plus, Server, Settings, Shield, ShieldCheck, Smile } from "lucide-react-native";
import { Alert, StyleSheet, View } from "react-native";

import { useAccounts, type Account } from "../../accounts/AccountsProvider";
import { hostOf } from "../../accounts/summary";
import { useTranslation } from "../../i18n";
import type { RootParams } from "../../navigation/types";
import { useSession } from "../../session/SessionProvider";
import { selfPresence } from "../../session/presence";
import { useTheme } from "../../theme/useTheme";
import { ActionRow } from "../../ui/ActionRow";
import { Avatar } from "../../ui/Avatar";
import { Button } from "../../ui/Button";
import { Sheet } from "../../ui/Sheet";
import { Text } from "../../ui/Text";
import { STATUS_TEXT } from "./StatusSheet";

/**
 * "My account" (mockup 11): who is signed in on the instance on screen, then their status, profile,
 * saved messages, preferences, security and help; the instances the phone holds (ADR 0007), each to
 * sign out of, remove or sign in again, and adding one; and signing out. Each row opens its own
 * screen or sheet in place of this one.
 */
export function AccountSheet() {
  const { t } = useTranslation();
  const { c } = useTheme();
  const session = useSession();
  const accounts = useAccounts();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  if (session.state.kind !== "signedIn") return null;
  const { user, server } = session.state;
  const presence = selfPresence(user.presenceChoice);
  const open = (route: "statusSheet" | "profile" | "saved" | "instanceAdmin" | "preferences" | "security" | "help") => {
    navigation.goBack();
    navigation.navigate(route);
  };

  return (
    <Sheet>
      <View style={styles.who}>
        <Avatar name={user.name} src={user.avatarUrl} size={48} presence={presence} />
        <View style={styles.flex}>
          <Text variant="heading">{user.name}</Text>
          <Text variant="small" tone="muted" numberOfLines={1}>
            {user.email}
          </Text>
        </View>
      </View>
      <ActionRow
        icon={CircleCheck}
        tint={c.mint}
        title={t(STATUS_TEXT[user.presenceChoice].title)}
        subtitle={t("account.status")}
        onPress={() => open("statusSheet")}
      />
      <ActionRow icon={Smile} tint={c.sky} title={t("account.profile")} onPress={() => open("profile")} />
      <ActionRow icon={Bookmark} tint={c.mint} title={t("saved.title")} subtitle={t("saved.hint")} onPress={() => open("saved")} />
      <ActionRow
        icon={Settings}
        tint={c.violet}
        title={t("account.preferences")}
        subtitle={t("account.preferencesHint")}
        onPress={() => open("preferences")}
      />
      <ActionRow
        icon={Shield}
        tint={c.peach}
        title={t("account.security")}
        subtitle={t("account.securityHint")}
        onPress={() => open("security")}
      />
      {user.isInstanceAdmin ? (
        <ActionRow icon={ShieldCheck} tint={c.pink} title={t("admin.screenTitle")} subtitle={t("admin.hint")} onPress={() => open("instanceAdmin")} />
      ) : null}
      <ActionRow icon={LifeBuoy} tint={c.sun} title={t("account.help")} onPress={() => open("help")} />
      <Text variant="smallStrong" tone="muted" style={styles.section}>
        {t("account.instances")}
      </Text>
      {accounts.accounts.map((account) => (
        <InstanceRow key={account.id} account={account} shown={account.origin === server} />
      ))}
      <ActionRow
        icon={Plus}
        title={t("spaces.addInstance")}
        subtitle={t("spaces.addInstanceHint")}
        onPress={() => {
          navigation.goBack();
          accounts.startAdd();
        }}
      />
      <Button
        variant="secondary"
        label={accounts.accounts.length > 1 ? t("account.signOutOf", { host: hostOf(server) }) : t("account.signOut")}
        icon={<LogOut size={18} color={c.ink} />}
        onPress={() => void session.signOut()}
        style={styles.signOut}
      />
    </Sheet>
  );
}

/**
 * An instance the phone holds: its host and how things stand there. A tap offers what can be done
 * with it: sign out of it or sign in again, or remove it from the phone.
 */
function InstanceRow({ account, shown }: { account: Account; shown: boolean }) {
  const { t } = useTranslation();
  const accounts = useAccounts();
  const navigation = useNavigation();
  const host = hostOf(account.origin);
  const status = account.status;
  const subtitle = shown
    ? t("account.instanceShown")
    : status.kind === "signedIn"
      ? t("account.instanceSignedInAs", { name: status.user.name })
      : t("account.instanceSignedOut");
  const remove = () =>
    Alert.alert(t("account.removeTitle", { host }), t("account.removeText"), [
      { text: t("compose.cancel"), style: "cancel" },
      { text: t("account.removeInstance"), style: "destructive", onPress: () => void accounts.remove(account.id) },
    ]);
  const manage = () =>
    Alert.alert(host, undefined, [
      status.kind === "signedIn"
        ? { text: t("account.signOutOf", { host }), onPress: () => void accounts.signOutOf(account.id) }
        : {
            text: t("spaces.signInAgain"),
            onPress: () => {
              navigation.goBack();
              accounts.renew(account.id);
            },
          },
      { text: t("account.removeInstance"), style: "destructive", onPress: remove },
      { text: t("compose.cancel"), style: "cancel" },
    ]);
  return <ActionRow icon={Server} title={host} subtitle={subtitle} onPress={manage} />;
}

const styles = StyleSheet.create({
  section: { marginTop: 14, marginBottom: 2 },
  who: { flexDirection: "row", alignItems: "center", gap: 14, marginBottom: 8 },
  flex: { flex: 1, minWidth: 0 },
  signOut: { marginTop: 12 },
});
