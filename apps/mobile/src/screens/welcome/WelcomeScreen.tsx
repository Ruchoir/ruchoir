import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { AtSign, Calendar, Folder, MessageSquare } from "lucide-react-native";
import { Image, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useTranslation } from "../../i18n";
import type { AuthParams } from "../../navigation/types";
import { useTheme } from "../../theme/useTheme";
import { Button } from "../../ui/Button";
import { Text } from "../../ui/Text";
import { Sticker } from "./Sticker";

/**
 * Welcome (mockup 01): what Ruchoir is, in a picture and two lines, then "Get started" (the
 * tutorial, then sign-up) or "I already have an account" (sign-in). Shown whenever nobody is signed in.
 */
export function WelcomeScreen() {
  const { t } = useTranslation();
  const { c } = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<AuthParams>>();

  return (
    <SafeAreaView style={[styles.fill, { backgroundColor: c.bg }]} edges={["top", "bottom"]}>
      <View style={styles.hero}>
        <View style={styles.cluster}>
          <Sticker icon={MessageSquare} color={c.sky} size={88} rotate={-8} style={[styles.at, { left: 8, top: 18 }]} />
          <Sticker icon={Calendar} color={c.violet} size={84} rotate={6} style={[styles.at, { right: 8, top: 0 }]} />
          <Sticker icon={Folder} color={c.mint} size={80} rotate={5} style={[styles.at, { left: 30, bottom: 0 }]} />
          <Sticker icon={AtSign} color={c.pink} size={80} rotate={-6} style={[styles.at, { right: 22, bottom: 14 }]} />
          <Sticker color="#f7f3ed" size={104} style={styles.mark}>
            <Image source={require("../../../assets/mark.png")} style={[styles.markImage, { tintColor: c.brand }]} />
          </Sticker>
        </View>
        <Text variant="display" style={styles.center}>
          {t("welcome.title")}
        </Text>
        <Text tone="body" style={[styles.center, styles.body]}>
          {t("welcome.body")}
        </Text>
      </View>
      <View style={styles.actions}>
        <Button label={t("welcome.start")} onPress={() => navigation.navigate("tutorial")} />
        <Button variant="secondary" label={t("welcome.haveAccount")} onPress={() => navigation.navigate("signIn")} />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  hero: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 24, gap: 14 },
  cluster: { width: 260, height: 236, marginBottom: 24 },
  at: { position: "absolute" },
  mark: { position: "absolute", left: 78, top: 66 },
  markImage: { width: 60, height: 60, marginTop: 6 },
  center: { textAlign: "center" },
  body: { maxWidth: 320 },
  actions: { paddingHorizontal: 24, paddingBottom: 16, gap: 12 },
});
