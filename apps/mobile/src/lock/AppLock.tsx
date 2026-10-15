/**
 * The app lock (step 6c): when this phone's owner has turned it on (Security), the app asks for Face
 * ID, Touch ID or the fingerprint at launch and on coming back after a minute away
 * (`logic/lock.ts`), and for a six-digit PIN of its own when they fail or the phone has none
 * (`logic/pin.ts`). The phone's passcode does not open it. Five wrong PINs in a row, or "Forgot your
 * PIN?", sign out: the PIN is chosen again once signed back in with the password. Off by default;
 * the setting and the PIN belong to this phone and this account (`lock/pinStore.ts`).
 *
 * The lock is drawn above everything (`FullWindowOverlay` on iOS, as the toasts are: a sheet or a
 * modal is a native screen above the app's view). While the app is away with the lock on, a plain
 * cover hides it from the app switcher; that one stays in the app's view, so a photo picker or a
 * system sheet opened from the app is never covered.
 */
import * as LocalAuthentication from "expo-local-authentication";
import { createContext, Fragment, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Alert, AppState, BackHandler, Image, Platform, StyleSheet, View } from "react-native";
import { FullWindowOverlay } from "react-native-screens";
import { SafeAreaView } from "react-native-safe-area-context";

import { key, useTranslation } from "../i18n";
import { lockOnReturn, usableBiometry, type BiometryKind } from "../logic/lock";
import { failuresLeft, isPin, lockedOut, pressKey, setupNext, type LockFlag, type Setup } from "../logic/pin";
import { useTheme } from "../theme/useTheme";
import { Button } from "../ui/Button";
import { feel } from "../ui/haptics";
import { Text } from "../ui/Text";
import { PinScreen } from "./PinPad";
import { checkPin, readLock, resetPin, savePin, setFailures, turnOff, turnOn } from "./pinStore";

type LockApi = {
  /** The phone's biometrics; null when it has none set up, and the lock is the PIN alone. */
  kind: BiometryKind | null;
  enabled: boolean;
  /** Turn the lock on (Face ID, then a PIN chosen) or off (Face ID or the PIN). False when not done. */
  setEnabled: (on: boolean) => Promise<boolean>;
  /** Choose another PIN, after Face ID or the current one. False when not done. */
  changePin: () => Promise<boolean>;
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

/** What the lock asks for over the app besides unlocking: a PIN to choose, or to confirm. */
type Ask =
  | { kind: "setup"; reason: "enable" | "change" | "reset" | "missing"; done: (pin: string | null) => void }
  | { kind: "verify"; done: (ok: boolean) => void };

export function AppLock({ userId, onSignOut, children }: { userId: string; onSignOut: (reason?: "locked") => void; children: ReactNode }) {
  const { t } = useTranslation();
  // Null until the Keychain has answered: the app stays covered meanwhile, so nothing shows before
  // a lock that is on.
  const [flag, setFlag] = useState<LockFlag | null>(null);
  const [hasPin, setHasPin] = useState(false);
  const [failures, setFailureCount] = useState(0);
  const [locked, setLocked] = useState(false);
  const [away, setAway] = useState(false);
  const [kind, setKind] = useState<BiometryKind | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const hiddenAt = useRef<number | null>(null);
  const enabledNow = useRef(false);
  const prompting = useRef(false);
  // The lock asks for Face ID by itself once each time it closes; after that, the key does.
  const asked = useRef(false);

  const choosePin = useCallback(
    (reason: "enable" | "change" | "reset" | "missing") => new Promise<string | null>((done) => setAsk({ kind: "setup", reason, done })),
    [],
  );

  useEffect(() => {
    let live = true;
    void readLock(userId).then(
      (stored) => {
        if (!live) return;
        enabledNow.current = stored.flag === "on";
        setFlag(stored.flag);
        setHasPin(stored.hasPin);
        setFailureCount(stored.failures);
        if (stored.flag === "on") setLocked(true);
        // Signed back in after a forgotten PIN: a new one, or the lock goes.
        if (stored.flag === "reset") {
          void choosePin("reset").then(async (pin) => {
            if (pin) await turnOn(userId, pin);
            else await turnOff(userId);
            enabledNow.current = pin !== null;
            setFlag(pin ? "on" : "off");
            setHasPin(pin !== null);
          });
        }
      },
      () => live && setFlag("off"),
    );
    void Promise.all([LocalAuthentication.getEnrolledLevelAsync(), LocalAuthentication.supportedAuthenticationTypesAsync()]).then(
      ([level, types]) => live && setKind(usableBiometry(level, types, Platform.OS === "android" ? "android" : "ios")),
      () => live && setKind(null),
    );
    return () => {
      live = false;
    };
  }, [userId, choosePin]);

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

  /**
   * Face ID (or Touch ID, the fingerprint). The phone's passcode is offered only to a lock turned on
   * before the PIN existed (`passcode`), which has nothing else to fall back on.
   */
  const authenticate = useCallback(
    async (passcode = false) => {
      if (prompting.current) return false;
      prompting.current = true;
      try {
        const result = await LocalAuthentication.authenticateAsync({
          promptMessage: t("lock.prompt"),
          cancelLabel: t("compose.cancel"),
          disableDeviceFallback: !passcode,
          ...(passcode ? {} : { fallbackLabel: t("lock.usePin") }),
        });
        return result.success;
      } catch {
        return false;
      } finally {
        prompting.current = false;
      }
    },
    [t],
  );

  const rightAgain = useCallback(() => {
    setFailureCount(0);
    void setFailures(userId, 0);
  }, [userId]);

  /** A forgotten PIN, or too many wrong ones: signed out, and a new PIN chosen after the password. */
  const forgetAndSignOut = useCallback(async () => {
    await resetPin(userId).catch(() => {});
    onSignOut("locked");
  }, [userId, onSignOut]);

  /** A PIN typed on the lock or to confirm an action: right, or one more wrong (five sign out). */
  const tryPin = useCallback(
    async (pin: string) => {
      if (await checkPin(userId, pin)) {
        rightAgain();
        return true;
      }
      const count = failures + 1;
      setFailureCount(count);
      await setFailures(userId, count).catch(() => {});
      if (lockedOut(count)) void forgetAndSignOut();
      return false;
    },
    [userId, failures, rightAgain, forgetAndSignOut],
  );

  const forgot = useCallback(() => {
    Alert.alert(t("lock.forgot"), t("lock.forgotBody"), [
      { text: t("compose.cancel"), style: "cancel" },
      { text: t("account.signOut"), style: "destructive", onPress: () => void forgetAndSignOut() },
    ]);
  }, [t, forgetAndSignOut]);

  /** Opens the lock by Face ID; a lock from before the PIN then asks for one. */
  const unlockByBiometry = useCallback(async () => {
    if (!(await authenticate(!hasPin))) return;
    rightAgain();
    setLocked(false);
    if (!hasPin) {
      const pin = await choosePin("missing");
      if (pin) {
        await savePin(userId, pin);
        setHasPin(true);
      } else {
        await turnOff(userId);
        enabledNow.current = false;
        setFlag("off");
      }
    }
  }, [authenticate, hasPin, rightAgain, choosePin, userId]);

  // Asks for Face ID at once when the lock closes and the app is in front; a cancel leaves the PIN.
  useEffect(() => {
    if (!locked || away || asked.current || flag !== "on") return;
    if (!kind && hasPin) return;
    // After this render: the prompt sets state once it answers.
    const timer = setTimeout(() => {
      asked.current = true;
      void unlockByBiometry();
    }, 0);
    return () => clearTimeout(timer);
  }, [locked, away, flag, kind, hasPin, unlockByBiometry]);

  /** Face ID or the PIN, over the app, before changing the lock. */
  const verify = useCallback(async () => {
    if (!hasPin) return authenticate(true);
    return new Promise<boolean>((done) => setAsk({ kind: "verify", done }));
  }, [hasPin, authenticate]);

  const setEnabled = useCallback(
    async (on: boolean) => {
      try {
        if (on) {
          if (kind && !(await authenticate())) return false;
          const pin = await choosePin("enable");
          if (!pin) return false;
          await turnOn(userId, pin);
          setHasPin(true);
        } else {
          if (!(await verify())) return false;
          await turnOff(userId);
          setHasPin(false);
        }
      } catch {
        return false;
      }
      enabledNow.current = on;
      setFlag(on ? "on" : "off");
      setFailureCount(0);
      return true;
    },
    [kind, authenticate, choosePin, verify, userId],
  );

  const changePin = useCallback(async () => {
    if (!(await verify())) return false;
    const pin = await choosePin("change");
    if (!pin) return false;
    try {
      await savePin(userId, pin);
    } catch {
      return false;
    }
    setHasPin(true);
    setFailureCount(0);
    return true;
  }, [verify, choosePin, userId]);

  const finish = <T,>(done: (value: T) => void, value: T) => {
    setAsk(null);
    done(value);
  };

  // Android's back button never reaches the screens under the lock; over a PIN asked for, it cancels.
  useEffect(() => {
    if (Platform.OS !== "android" || (!locked && !ask)) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!locked && ask) {
        setAsk(null);
        if (ask.kind === "setup") ask.done(null);
        else ask.done(false);
      }
      return true;
    });
    return () => subscription.remove();
  }, [locked, ask]);

  const api = useMemo(() => ({ kind, enabled: flag === "on", setEnabled, changePin }), [kind, flag, setEnabled, changePin]);
  return (
    <LockContext.Provider value={api}>
      {children}
      {flag === null || (flag === "on" && away && !locked) ? <Cover /> : null}
      {ask && !locked ? (
        <Above>
          {ask.kind === "setup" ? (
            <ChoosePin
              biometry={kind}
              reason={ask.reason}
              onDone={(pin) => finish(ask.done, pin)}
              onCancel={() => finish(ask.done, null)}
            />
          ) : (
            <CheckPin
              key="verify"
              title={t("lock.verifyTitle")}
              failures={failures}
              tryPin={tryPin}
              onRight={() => finish(ask.done, true)}
              biometry={kind}
              autoBiometry
              onBiometry={async () => {
                if (await authenticate()) {
                  rightAgain();
                  finish(ask.done, true);
                }
              }}
              action={{ label: t("compose.cancel"), onPress: () => finish(ask.done, false) }}
            />
          )}
        </Above>
      ) : null}
      {locked ? (
        <Above>
          {hasPin ? (
            <CheckPin
              key="unlock"
              title={t("lock.enterPin")}
              failures={failures}
              tryPin={tryPin}
              onRight={() => setLocked(false)}
              biometry={kind}
              onBiometry={() => void unlockByBiometry()}
              action={{ label: t("lock.forgot"), onPress: forgot }}
            />
          ) : (
            <BiometryLock kind={kind} onUnlock={() => void unlockByBiometry()} onSignOut={() => void forgetAndSignOut()} />
          )}
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

/** The time the sixth dot stays on screen before the PIN is checked. */
const SHOW_LAST_MS = 120;

/** A PIN to type, on the lock or before changing it; Face ID beside it when the phone has it. */
function CheckPin({
  title,
  failures,
  tryPin,
  onRight,
  biometry,
  autoBiometry = false,
  onBiometry,
  action,
}: {
  title: string;
  failures: number;
  tryPin: (pin: string) => Promise<boolean>;
  onRight: () => void;
  biometry: BiometryKind | null;
  /** Ask for Face ID as soon as the screen opens (confirming an action; the lock asks by itself). */
  autoBiometry?: boolean;
  onBiometry: () => void;
  action: { label: string; onPress: () => void };
}) {
  const { t } = useTranslation();
  const [entry, setEntry] = useState("");
  const [busy, setBusy] = useState(false);
  const typed = useRef("");

  useEffect(() => {
    if (autoBiometry && biometry) onBiometry();
    // Once, as the screen opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const press = async (pressed: string) => {
    const next = pressKey(typed.current, pressed);
    typed.current = next;
    setEntry(next);
    if (!isPin(next)) return;
    setBusy(true);
    await new Promise((wait) => setTimeout(wait, SHOW_LAST_MS));
    const right = await tryPin(next);
    typed.current = "";
    setEntry("");
    setBusy(false);
    if (right) onRight();
    else feel("failure");
  };

  return (
    <PinScreen
      title={title}
      message={failures > 0 ? t("lock.wrongPin", { count: failuresLeft(failures) }) : undefined}
      error={failures > 0}
      entry={entry}
      onKey={(pressed) => void press(pressed)}
      busy={busy}
      biometry={biometry}
      onBiometry={onBiometry}
      action={action}
    />
  );
}

/** A new PIN, typed twice. */
function ChoosePin({
  biometry,
  reason,
  onDone,
  onCancel,
}: {
  biometry: BiometryKind | null;
  reason: "enable" | "change" | "reset" | "missing";
  onDone: (pin: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [setup, setSetup] = useState<Setup>({ step: "choose" });
  const [entry, setEntry] = useState("");
  const [mismatch, setMismatch] = useState(false);
  const [busy, setBusy] = useState(false);
  const typed = useRef("");

  const press = async (pressed: string) => {
    const next = pressKey(typed.current, pressed);
    typed.current = next;
    setEntry(next);
    if (next.length > 0) setMismatch(false);
    if (!isPin(next)) return;
    setBusy(true);
    await new Promise((wait) => setTimeout(wait, SHOW_LAST_MS));
    typed.current = "";
    setEntry("");
    setBusy(false);
    const result = setupNext(setup, next);
    if (result.pin) return onDone(result.pin);
    setSetup(result.setup);
    if (result.mismatch) {
      setMismatch(true);
      feel("failure");
    }
  };

  const title =
    setup.step === "confirm"
      ? t("lock.confirmPin")
      : reason === "reset" || reason === "change"
        ? t("lock.chooseNewPin")
        : t("lock.choosePin");
  const hint = mismatch
    ? t("lock.pinMismatch")
    : setup.step === "confirm"
      ? undefined
      : reason === "reset"
        ? t("lock.resetHint")
        : biometry
          ? t("lock.choosePinHint")
          : t("lock.choosePinAloneHint");

  return (
    <PinScreen
      title={title}
      message={hint}
      error={mismatch}
      entry={entry}
      onKey={(pressed) => void press(pressed)}
      busy={busy}
      action={{ label: reason === "reset" || reason === "missing" ? t("lock.noLock") : t("compose.cancel"), onPress: onCancel }}
    />
  );
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

/** A lock turned on before the PIN existed: Face ID (or the phone's passcode), then a PIN is chosen. */
function BiometryLock({ kind, onUnlock, onSignOut }: { kind: BiometryKind | null; onUnlock: () => void; onSignOut: () => void }) {
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
