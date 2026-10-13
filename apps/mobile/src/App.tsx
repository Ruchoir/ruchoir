import { useFonts } from "expo-font";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { RootNavigator } from "./navigation/RootNavigator";
import { OutboxProvider } from "./compose/useOutbox";
import { RealtimeProvider } from "./realtime/RealtimeProvider";
import { MfaScreen } from "./screens/auth/MfaScreen";
import { SignInScreen } from "./screens/auth/SignInScreen";
import { BootScreen } from "./screens/boot/BootScreen";
import { SessionProvider, useSession } from "./session/SessionProvider";
import { SpaceProvider } from "./space/SpaceProvider";
import { ToastProvider } from "./ui/Toast";
import { fontFiles } from "./theme/fonts";
import { useTheme } from "./theme/useTheme";

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
      return (
        <RealtimeProvider>
          <OutboxProvider>
            <SpaceProvider>
              <ToastProvider>
                <RootNavigator />
              </ToastProvider>
            </SpaceProvider>
          </OutboxProvider>
        </RealtimeProvider>
      );
  }
}

