import { useFonts } from "expo-font";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { KeyboardProvider } from "react-native-keyboard-controller";
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
import { UploadsProvider } from "./uploads/UploadsProvider";
import { loadPrefs } from "./prefs/store";
import { fontFiles } from "./theme/fonts";
import { useTheme } from "./theme/useTheme";

/**
 * The app's root. Fonts and preferences load before anything is drawn, so no text ever flashes in a
 * system face, the wrong colours or the wrong language.
 */
export default function App() {
  const [fontsLoaded] = useFonts(fontFiles);
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  useEffect(() => {
    void loadPrefs().finally(() => setPrefsLoaded(true));
  }, []);
  const { dark } = useTheme();
  return (
    <SafeAreaProvider>
      {/* Where the keyboard is, frame by frame, for every `KeyboardArea` (see `ui/KeyboardArea`). */}
      <KeyboardProvider>
        <StatusBar style={dark ? "light" : "dark"} />
        <SessionProvider>{fontsLoaded && prefsLoaded ? <Root /> : <BootScreen />}</SessionProvider>
      </KeyboardProvider>
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
                <UploadsProvider>
                  <RootNavigator />
                </UploadsProvider>
              </ToastProvider>
            </SpaceProvider>
          </OutboxProvider>
        </RealtimeProvider>
      );
  }
}

