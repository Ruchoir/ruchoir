import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { ScrollView, StyleSheet, View } from "react-native";

import { useTranslation } from "../../i18n";
import type { AuthParams } from "../../navigation/types";
import { useTheme } from "../../theme/useTheme";
import { SheetHeader } from "../../ui/SheetHeader";
import { Text } from "../../ui/Text";
import { InvitationPaste } from "../space/InvitationPaste";

/** "I have an invitation link", from sign-up: the link names the server and the space to join. */
export function InvitationLinkScreen() {
  const { t } = useTranslation();
  const { c } = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<AuthParams>>();
  return (
    <ScrollView style={{ backgroundColor: c.bg }} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <SheetHeader title={t("invitation.title")} onClose={() => navigation.goBack()} />
      <Text tone="body" style={styles.intro}>
        {t("invitation.intro")}
      </Text>
      <View style={styles.paste}>
        <InvitationPaste switchServer onResolved={(invitation) => navigation.popTo("signUp", { invitation })} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 32, gap: 14 },
  intro: { paddingHorizontal: 16 },
  paste: { paddingHorizontal: 16 },
});
