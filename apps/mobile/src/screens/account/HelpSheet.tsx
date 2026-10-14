import { createDm, getSpaceMembers, getUserProfile } from "@ruchoir/client";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import Constants from "expo-constants";
import { GraduationCap, Info, MessageSquare } from "lucide-react-native";

import { useLoad } from "../../data/useLoad";
import { useTranslation } from "../../i18n";
import type { RootParams } from "../../navigation/types";
import { useSession } from "../../session/SessionProvider";
import { useSpace } from "../../space/SpaceProvider";
import { useTheme } from "../../theme/useTheme";
import { ActionRow } from "../../ui/ActionRow";
import { Sheet } from "../../ui/Sheet";
import { Text } from "../../ui/Text";
import { useToast } from "../../ui/Toast";

/** How many of the space's members are looked at for its instance's administrators. */
const LOOKED_AT = 40;

/**
 * Help: the tutorial again, which app and which server this is, and a direct message to an
 * administrator of the instance when the instance shows who they are (their profiles say so).
 */
export function HelpSheet() {
  const { t } = useTranslation();
  const { c } = useTheme();
  const toast = useToast();
  const session = useSession();
  const { current } = useSpace();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const me = session.state.kind === "signedIn" ? session.state.user : null;
  const server = session.state.kind === "signedIn" ? session.state.server : "";

  const admins = useLoad(current ? `admins:${current.id}` : null, async (signal) => {
    const members = (await getSpaceMembers(current!.id, signal)).filter((m) => !m.bot && m.userId !== me?.id).slice(0, LOOKED_AT);
    const profiles = await Promise.all(
      members.map((m) => getUserProfile(m.userId, signal).then((p) => ({ ...m, admin: p.instanceAdmin === true }), () => null)),
    );
    return profiles.filter((p): p is NonNullable<typeof p> => p !== null && p.admin);
  });

  const write = async (userId: string, name: string) => {
    if (!current) return;
    try {
      const conversationId = await createDm(current.id, [userId]);
      navigation.goBack();
      navigation.navigate("conversation", { conversationId, title: name, kind: "person" });
    } catch {
      toast(t("load.failed"), "failure");
    }
  };

  return (
    <Sheet>
      <Text variant="heading">{t("account.help")}</Text>
      <ActionRow
        icon={GraduationCap}
        tint={c.violet}
        title={t("help.tutorial")}
        onPress={() => {
          navigation.goBack();
          navigation.navigate("tutorial", { replay: true });
        }}
      />
      {admins.data?.map((admin) => (
        <ActionRow
          key={admin.userId}
          icon={MessageSquare}
          tint={c.mint}
          title={t("people.writeTo", { name: admin.name })}
          subtitle={t("help.admin")}
          onPress={() => void write(admin.userId, admin.name)}
        />
      ))}
      <ActionRow
        icon={Info}
        tint={c.sky}
        title={t("help.version", { version: Constants.expoConfig?.version ?? "" })}
        subtitle={server.replace(/^https:\/\//, "")}
      />
    </Sheet>
  );
}
