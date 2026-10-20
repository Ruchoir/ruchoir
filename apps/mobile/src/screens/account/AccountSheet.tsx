import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Bookmark, CircleCheck, LifeBuoy, LogOut, Server, Settings, Shield, Smile } from "lucide-react-native";
import { StyleSheet, View } from "react-native";

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
 * "My account" (mockup 11): who is signed in, then their status, profile, saved messages,
 * preferences, security and help, the server, and signing out. Each row opens its own screen or sheet in place of this one.
 */
export function AccountSheet() {
  const { t } = useTranslation();
  const { c } = useTheme();
  const session = useSession();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  if (session.state.kind !== "signedIn") return null;
  const { user, server } = session.state;
  const presence = selfPresence(user.presenceChoice);
  const open = (route: "statusSheet" | "profile" | "saved" | "preferences" | "security" | "help") => {
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
      <ActionRow icon={LifeBuoy} tint={c.sun} title={t("account.help")} onPress={() => open("help")} />
      <ActionRow icon={Server} title={server.replace(/^https:\/\//, "")} subtitle={t("signIn.server")} />
      <Button
        variant="secondary"
        label={t("account.signOut")}
        icon={<LogOut size={18} color={c.ink} />}
        onPress={() => void session.signOut()}
        style={styles.signOut}
      />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  who: { flexDirection: "row", alignItems: "center", gap: 14, marginBottom: 8 },
  flex: { flex: 1, minWidth: 0 },
  signOut: { marginTop: 12 },
});
