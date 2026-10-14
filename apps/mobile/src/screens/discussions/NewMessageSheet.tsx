/**
 * "New message" (mockup 12's sheet): write to a person, create a group, invite someone. Each only to
 * whoever may do it: a guest does not open groups, and inviting is for a space's admins.
 */
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { SquarePen, UserPlus, Users } from "lucide-react-native";
import { StyleSheet } from "react-native";

import { useTranslation } from "../../i18n";
import type { RootParams } from "../../navigation/types";
import { useSpace } from "../../space/SpaceProvider";
import { useTheme } from "../../theme/useTheme";
import { ActionRow } from "../../ui/ActionRow";
import { Sheet } from "../../ui/Sheet";
import { Text } from "../../ui/Text";

export function NewMessageSheet() {
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const { t } = useTranslation();
  const { c } = useTheme();
  const { current } = useSpace();
  const role = current?.role;
  // The sheet goes away first, then the screen slides up in its place.
  const open = (screen: "newConversation" | "newGroup" | "invite") => {
    navigation.goBack();
    navigation.navigate(screen);
  };
  return (
    <Sheet>
      <Text variant="heading" style={styles.title}>
        {t("newMessage.title")}
      </Text>
      <ActionRow
        icon={SquarePen}
        tint={c.sky}
        title={t("newMessage.person")}
        subtitle={t("newMessage.personHint")}
        onPress={() => open("newConversation")}
      />
      {role !== "guest" ? (
        <ActionRow
          icon={Users}
          tint={c.mint}
          title={t("newMessage.group")}
          subtitle={t("newMessage.groupHint")}
          onPress={() => open("newGroup")}
        />
      ) : null}
      {role === "owner" || role === "admin" ? (
        <ActionRow
          icon={UserPlus}
          tint={c.pink}
          title={t("newMessage.invite")}
          subtitle={t("newMessage.inviteHint")}
          onPress={() => open("invite")}
        />
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  title: { marginBottom: 6 },
});
