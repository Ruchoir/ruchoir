import { CircleCheck, LogOut, Server } from "lucide-react-native";
import { StyleSheet, View } from "react-native";

import { key, useTranslation } from "../../i18n";
import { useSession } from "../../session/SessionProvider";
import { selfPresence } from "../../session/presence";
import { useTheme } from "../../theme/useTheme";
import { Avatar } from "../../ui/Avatar";
import { ActionRow } from "../../ui/ActionRow";
import { Button } from "../../ui/Button";
import { Sheet } from "../../ui/Sheet";
import { Text } from "../../ui/Text";

const PRESENCE_TEXT = {
  online: key("presence.online"),
  away: key("presence.away"),
  busy: key("presence.busy"),
  offline: key("presence.offline"),
};

/**
 * "My account" (mockup 11), as far as step 1 goes: who is signed in, how they show, on which server,
 * and signing out. Profile, preferences and help arrive with step 5.
 */
export function AccountSheet() {
  const { t } = useTranslation();
  const { c } = useTheme();
  const session = useSession();
  if (session.state.kind !== "signedIn") return null;
  const { user, server } = session.state;
  const presence = selfPresence(user.presenceChoice);

  return (
    <Sheet>
      <View style={styles.who}>
        <Avatar name={user.name} size={48} presence={presence} />
        <View style={styles.flex}>
          <Text variant="heading">{user.name}</Text>
          <Text variant="small" tone="muted" numberOfLines={1}>
            {user.email}
          </Text>
        </View>
      </View>
      <ActionRow icon={CircleCheck} tint={c.mint} title={t(PRESENCE_TEXT[presence])} subtitle={t("account.status")} />
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
