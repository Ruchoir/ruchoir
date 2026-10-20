import { useFonts } from "expo-font";
import * as ScreenOrientation from "expo-screen-orientation";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { Dimensions } from "react-native";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { AccountsProvider, useAccounts, type Account } from "./accounts/AccountsProvider";
import { InstanceScope } from "./accounts/InstanceScope";
import { useLinkRouter } from "./accounts/useLinkRouter";
import { AppLock } from "./lock/AppLock";
import { isTablet } from "./layout/wide";
import { AuthNavigator } from "./navigation/AuthNavigator";
import { MfaScreen } from "./screens/auth/MfaScreen";
import { BootScreen } from "./screens/boot/BootScreen";
import { SignInFlow, useSession, type FlowStart } from "./session/SessionProvider";
import { SpaceGate } from "./space/SpaceGate";
import { ToastProvider } from "./ui/Toast";
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
    // A tablet turns every way (`app.config.ts`); a phone stays upright, as the mockups are drawn.
    const screen = Dimensions.get("screen");
    if (!isTablet(screen.width, screen.height)) {
      void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
    }
  }, []);
  const { dark } = useTheme();
  return (
    <SafeAreaProvider>
      {/* Where the keyboard is, frame by frame, for every `KeyboardArea` (see `ui/KeyboardArea`). */}
      <KeyboardProvider>
        <StatusBar style={dark ? "light" : "dark"} />
        <AccountsProvider>{fontsLoaded && prefsLoaded ? <Root /> : <BootScreen />}</AccountsProvider>
      </KeyboardProvider>
    </SafeAreaProvider>
  );
}

/**
 * Which screen the accounts call for (ADR 0007): the sign-in flow while nothing is signed in, or
 * while an instance is being added or renewed; else the app, one scope per signed-in instance, the
 * active one drawing the interface.
 */
function Root() {
  const accounts = useAccounts();
  useLinkRouter();
  if (!accounts.booted) return <BootScreen />;
  const signedIn = accounts.accounts.filter((a): a is Account & { status: { kind: "signedIn" } } => a.status.kind === "signedIn");
  const { flow } = accounts;
  if (flow || signedIn.length === 0) {
    // The phone holds sessions it could not check (no network): wait for the network, not a sign-in.
    if (!flow && accounts.accounts.some((a) => a.status.kind === "offline")) {
      return <BootScreen offline onRetry={accounts.retryOffline} />;
    }
    const renewing = flow?.kind === "renew" ? accounts.accounts.find((a) => a.id === flow.id) : flow ? undefined : accounts.accounts[0];
    const start: FlowStart = renewing
      ? { server: renewing.origin, reason: renewing.status.kind === "signedOut" ? (renewing.status.reason ?? "expired") : "expired" }
      : { server: flow?.kind === "add" ? (flow.server ?? null) : null };
    return (
      <SignInFlow
        key={flow ? `${flow.kind}:${renewing?.id ?? (flow.kind === "add" ? (flow.server ?? "") : "")}` : "first"}
        start={start}
        invitation={flow?.invitation}
        isSignedIn={accounts.isSignedIn}
        onSignedIn={accounts.completeSignIn}
        onCancel={signedIn.length > 0 ? accounts.cancelFlow : undefined}
      >
        <FlowScreens />
      </SignInFlow>
    );
  }
  const active = accounts.active ?? signedIn[0];
  return (
    <ToastProvider>
      <AppLock lockId="app" legacyIds={signedIn.map((a) => a.status.user.id)} onSignOut={() => void accounts.signOutEverywhere("locked")}>
        {signedIn.map((account) => (
          <InstanceScope key={account.id} account={account} user={account.status.user} active={account.id === active.id}>
            <SpaceGate instanceId={account.id} />
          </InstanceScope>
        ))}
      </AppLock>
    </ToastProvider>
  );
}

/** The screens before sign-in: the second factor, or the welcome, sign-in and sign-up. */
function FlowScreens() {
  const session = useSession();
  return session.state.kind === "mfa" ? <MfaScreen /> : <AuthNavigator />;
}
