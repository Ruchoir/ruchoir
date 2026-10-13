import { useFonts } from "expo-font";
import { StatusBar } from "expo-status-bar";
import { StyleSheet, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { useTranslation } from "./i18n";
import { MfaScreen } from "./screens/auth/MfaScreen";
import { SignInScreen } from "./screens/auth/SignInScreen";
import { BootScreen } from "./screens/boot/BootScreen";
import { SessionProvider, useSession } from "./session/SessionProvider";
import { fontFiles } from "./theme/fonts";
import { useTheme } from "./theme/useTheme";
import { Button } from "./ui/Button";
import { Text } from "./ui/Text";

/** The app's root. Fonts load before anything is drawn, so no text ever flashes in a system face. */
export default function App() {
  const [fontsLoaded] = useFonts(fontFiles);
  const { dark } = useTheme();
  return (
    <SafeAreaProvider>
      <StatusBar style={dark ? "light" : "dark"} />
      <SessionProvider>{fontsLoaded ? <Root /> : <BootScreen />}</SessionProvider>
    </SafeAreaProvider>
  );
}

/** Which screen the session calls for. */
function Root() {
  const session = useSession();
  switch (session.state.kind) {
    case "booting":
      return <BootScreen offline={session.offlineAtBoot} onRetry={session.retryBoot} />;
    case "needsServer":
    case "signedOut":
      return <SignInScreen />;
    case "mfa":
      return <MfaScreen />;
    case "signedIn":
      return <SignedIn name={session.state.user.name} onSignOut={() => void session.signOut()} />;
  }
}

/** Stand-in for the tab shell, which arrives with the next change. */
function SignedIn({ name, onSignOut }: { name: string; onSignOut: () => void }) {
  const { c } = useTheme();
  const { t } = useTranslation();
  return (
    <View style={[styles.center, { backgroundColor: c.bg }]}>
      <Text variant="title">{name}</Text>
      <Button variant="secondary" size="md" label={t("account.signOut")} onPress={onSignOut} />
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16 },
});
