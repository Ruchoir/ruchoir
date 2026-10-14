/**
 * The Face ID lock (step 6c): when this phone's owner has turned it on (Security), the app asks for
 * Face ID, Touch ID or the fingerprint at launch and on coming back after a minute away
 * (`logic/lock.ts`), the phone's passcode being accepted when the biometrics fail, as the system
 * offers. Off by default; the setting belongs to this phone and this account.
 *
 * The lock is drawn above everything (`FullWindowOverlay` on iOS, as the toasts are: a sheet or a
 * modal is a native screen above the app's view). While the app is away with the lock on, a plain
 * cover hides it from the app switcher; that one stays in the app's view, so a photo picker or a
 * system sheet opened from the app is never covered.
 */
import * as LocalAuthentication from "expo-local-authentication";
import * as SecureStore from "expo-secure-store";
import { createContext, Fragment, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState, Image, Platform, StyleSheet, View } from "react-native";
import { FullWindowOverlay } from "react-native-screens";
import { SafeAreaView } from "react-native-safe-area-context";

import { key, useTranslation } from "../i18n";
import { biometryKind, lockOnReturn, type BiometryKind } from "../logic/lock";
import { useTheme } from "../theme/useTheme";
import { Button } from "../ui/Button";
import { Text } from "../ui/Text";

type LockApi = {
  /** What the phone unlocks with; null when it has neither biometrics nor a passcode set up. */
  kind: BiometryKind | null;
  enabled: boolean;
  /** Turn the lock on or off, after the biometrics agree. False when they did not. */
  setEnabled: (on: boolean) => Promise<boolean>;
};

const LockContext = createContext<LockApi | null>(null);

/** Above every modal and sheet on iOS; Android draws its modals in the app's own view. */
const Above = Platform.OS === "ios" ? FullWindowOverlay : Fragment;

const mark = require("../../assets/mark.png");

const UNLOCK = {
  faceId: key("lock.unlockFaceId"),
  touchId: key("lock.unlockTouchId"),
  other: key("lock.unlock"),
};

export function AppLock({ userId, onSignOut, children }: { userId: string; onSignOut: () => void; children: ReactNode }) {
  const { t } = useTranslation();
  const storeKey = `ruchoir.lock.${userId}`;
  // Null until the Keychain has answered: the app stays covered meanwhile, so nothing shows before
  // a lock that is on.
  const [enabled, setEnabledState] = useState<boolean | null>(null);
  const [locked, setLocked] = useState(false);
  const [away, setAway] = useState(false);
  const [kind, setKind] = useState<BiometryKind | null>(null);
  const hiddenAt = useRef<number | null>(null);
  const enabledNow = useRef(false);
  const prompting = useRef(false);
  // The lock asks by itself once each time it closes; after that, the button does.
  const asked = useRef(false);

  useEffect(() => {
    let live = true;
    void SecureStore.getItemAsync(storeKey).then(
      (value) => {
        if (!live) return;
        const on = value === "1";
        enabledNow.current = on;
        setEnabledState(on);
        if (on) setLocked(true);
      },
      () => live && setEnabledState(false),
    );
    void Promise.all([LocalAuthentication.getEnrolledLevelAsync(), LocalAuthentication.supportedAuthenticationTypesAsync()]).then(
      ([level, types]) => live && setKind(level === LocalAuthentication.SecurityLevel.NONE ? null : biometryKind(types, Platform.OS === "android" ? "android" : "ios")),
      () => live && setKind(null),
    );
    return () => {
      live = false;
    };
  }, [storeKey]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        setAway(false);
        if (lockOnReturn(enabledNow.current, hiddenAt.current, Date.now())) {
          asked.current = false;
          setLocked(true);
        }
        hiddenAt.current = null;
        return;
      }
      setAway(true);
      // "inactive" is also Face ID's own prompt, or a call: only the background starts the clock.
      if (state === "background" && hiddenAt.current === null) hiddenAt.current = Date.now();
    });
    return () => subscription.remove();
  }, []);

  const authenticate = useCallback(async () => {
    if (prompting.current) return false;
    prompting.current = true;
    try {
      const result = await LocalAuthentication.authenticateAsync({ promptMessage: t("lock.prompt"), cancelLabel: t("compose.cancel") });
      return result.success;
    } catch {
      return false;
    } finally {
      prompting.current = false;
    }
  }, [t]);

  const unlock = useCallback(async () => {
    if (await authenticate()) setLocked(false);
  }, [authenticate]);

  // Asks at once when the lock closes and the app is in front; a cancel leaves the button.
  useEffect(() => {
    if (!locked || away || asked.current) return;
    asked.current = true;
    void unlock();
  }, [locked, away, unlock]);

  const setEnabled = useCallback(
    async (on: boolean) => {
      if (!(await authenticate())) return false;
      try {
        if (on) await SecureStore.setItemAsync(storeKey, "1");
        else await SecureStore.deleteItemAsync(storeKey);
      } catch {
        return false;
      }
      enabledNow.current = on;
      setEnabledState(on);
      return true;
    },
    [authenticate, storeKey],
  );

  const api = useMemo(() => ({ kind, enabled: enabled === true, setEnabled }), [kind, enabled, setEnabled]);
  return (
    <LockContext.Provider value={api}>
      {children}
      {enabled === null || (enabled && away && !locked) ? <Cover /> : null}
      {locked ? (
        <Above>
          <LockScreen kind={kind} onUnlock={() => void unlock()} onSignOut={onSignOut} />
        </Above>
      ) : null}
    </LockContext.Provider>
  );
}

export function useAppLock(): LockApi {
  const api = useContext(LockContext);
  if (!api) throw new Error("useAppLock outside AppLock");
  return api;
}

/** The plain face the app shows while it is away with the lock on, and before the lock is known. */
function Cover() {
  const { c } = useTheme();
  return (
    <View style={[StyleSheet.absoluteFill, styles.center, { backgroundColor: c.bg }]}>
      <Image source={mark} style={[styles.mark, { tintColor: c.brand }]} accessibilityIgnoresInvertColors />
    </View>
  );
}

function LockScreen({ kind, onUnlock, onSignOut }: { kind: BiometryKind | null; onUnlock: () => void; onSignOut: () => void }) {
  const { t } = useTranslation();
  const { c } = useTheme();
  return (
    <SafeAreaView style={[StyleSheet.absoluteFill, { backgroundColor: c.bg }]}>
      <View style={[styles.fill, styles.center]}>
        <Image source={mark} style={[styles.mark, { tintColor: c.brand }]} accessibilityIgnoresInvertColors />
        <Text variant="title" style={styles.title}>
          {t("lock.title")}
        </Text>
      </View>
      <View style={styles.actions}>
        <Button label={t(UNLOCK[kind === "faceId" || kind === "touchId" ? kind : "other"])} onPress={onUnlock} />
        <Button variant="ghost" label={t("account.signOut")} onPress={onSignOut} />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { alignItems: "center", justifyContent: "center" },
  mark: { width: 56, height: 56 },
  title: { marginTop: 20, textAlign: "center" },
  actions: { gap: 8, paddingHorizontal: 20, paddingBottom: 16 },
});
