"use client";

import { type CSSProperties, useEffect, useState } from "react";
import { Button } from "@/components/ds";
import {
  createNativeCode,
  getSession,
  login,
  logout,
  redeemWebHandoff,
  registerPasskey,
  verifyRecoveryCode,
  verifyTotp,
  verifyPasskey,
  type MfaMethod,
  type SessionUser,
} from "@/lib/data/api";
import { key, type TranslationKey, useTranslation } from "@/lib/i18n";
import { authMessage } from "./authMessage";
import { AuthShell } from "./AuthShell";
import { authStyles } from "./authStyles";
import { LoginScreen } from "./LoginScreen";
import { MfaChallengeScreen } from "./MfaChallengeScreen";

/**
 * The page the phone app opens in the system's authentication browser (`/n/`, ADR 0005, step 6f),
 * since an app cannot run a passkey ceremony for an instance it does not know at build time:
 *
 * - `?c=<challenge>&e=<email>`: sign the app in. The person signs in here as on the web (password,
 *   then passkey or code), then allows the app; the page mints a single-use code bound to the app's
 *   challenge and hands it back on `ruchoir://auth`. The app trades it, with its verifier, for a
 *   session of its own.
 * - `?h=<code>`: add a passkey. The app's single-use code signs this page in, the browser runs the
 *   ceremony, and the page goes back to the app on `ruchoir://passkey`.
 *
 * A web session this page opened only for the purpose is ended before going back to the app.
 */

/** Where the app waits. Fixed, never read from the address, so this page can send nowhere else. */
const APP_SIGN_IN = "ruchoir://auth";
const APP_PASSKEY = "ruchoir://passkey";

type Stage =
  | { kind: "checking" }
  | { kind: "signIn" }
  | { kind: "mfa"; methods: MfaMethod[]; mfaToken: string }
  | { kind: "consent"; user: SessionUser; fresh: boolean }
  | { kind: "passkey"; user: SessionUser }
  | { kind: "done" }
  | { kind: "gone" };

const styles: Record<string, CSSProperties> = {
  actions: { display: "flex", flexDirection: "column", gap: 10, marginTop: 8 },
  body: { ...authStyles.subtitle, overflowWrap: "anywhere" },
};

/** Whether `challenge` is a SHA-256 in lowercase hex, as the app sends it. */
function plausibleChallenge(challenge: string): boolean {
  return /^[0-9a-f]{64}$/.test(challenge);
}

export function NativeHandoffScreen() {
  const { t } = useTranslation();
  const [stage, setStage] = useState<Stage>({ kind: "checking" });
  const [params, setParams] = useState({ challenge: "", email: "", handoff: "" });
  const [error, setError] = useState<TranslationKey | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    // Read once the page is in the browser (the export renders it without an address), outside the
    // effect's own turn, as the other screens do.
    const timer = setTimeout(() => {
      const query = new URLSearchParams(window.location.search);
      const found = { challenge: query.get("c") ?? "", email: query.get("e") ?? "", handoff: query.get("h") ?? "" };
      setParams(found);
      if (found.handoff) {
        redeemWebHandoff(found.handoff)
          .then((user) => setStage({ kind: "passkey", user }))
          .catch(() => setStage({ kind: "gone" }));
        return;
      }
      if (!plausibleChallenge(found.challenge)) {
        setStage({ kind: "gone" });
        return;
      }
      // Already signed in on this browser (Android's Custom Tabs share the browser's cookies): the
      // person only has to allow the app.
      getSession()
        .then((user) => setStage({ kind: "consent", user, fresh: false }))
        .catch(() => setStage({ kind: "signIn" }));
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  /** Back to the app, ending first a web session opened only for this. */
  const backToApp = async (address: string, fresh: boolean) => {
    if (fresh) await logout().catch(() => {});
    setStage({ kind: "done" });
    window.location.href = address;
  };

  const run = async (work: () => Promise<void>, fallback: TranslationKey) => {
    setError(null);
    setPending(true);
    try {
      await work();
    } catch (err) {
      const cancelled = err instanceof DOMException && err.name === "NotAllowedError";
      setError(cancelled ? key("error.passkeyCancelled") : authMessage(err, fallback));
    } finally {
      setPending(false);
    }
  };

  const signIn = (email: string, password: string) =>
    void run(async () => {
      const result = await login(email, password);
      if (result.kind === "mfa") setStage({ kind: "mfa", methods: result.methods, mfaToken: result.mfaToken });
      else setStage({ kind: "consent", user: result.user, fresh: true });
    }, key("error.signInFailed"));

  const secondFactor = (verify: (mfaToken: string) => Promise<SessionUser>, fallback: TranslationKey) => {
    if (stage.kind !== "mfa") return;
    const { mfaToken } = stage;
    void run(async () => setStage({ kind: "consent", user: await verify(mfaToken), fresh: true }), fallback);
  };

  const allow = (fresh: boolean) =>
    void run(async () => {
      const code = await createNativeCode(params.challenge);
      await backToApp(`${APP_SIGN_IN}?code=${encodeURIComponent(code)}`, fresh);
    }, key("error.signInFailed"));

  const addPasskey = () =>
    void run(async () => {
      await registerPasskey();
      await backToApp(`${APP_PASSKEY}?added=1`, true);
    }, key("error.passkeyFailedBody"));

  const shown = error ? t(error) : null;

  switch (stage.kind) {
    case "checking":
      return (
        <AuthShell>
          <p style={authStyles.subtitle}>{t("common.loading")}</p>
        </AuthShell>
      );
    case "gone":
      return (
        <AuthShell>
          <h1 style={authStyles.title}>{t("handoff.goneTitle")}</h1>
          <p style={authStyles.subtitle}>{t("handoff.goneBody")}</p>
        </AuthShell>
      );
    case "done":
      return (
        <AuthShell>
          <h1 style={authStyles.title}>{t("handoff.doneTitle")}</h1>
          <p style={authStyles.subtitle}>{t("handoff.doneBody")}</p>
        </AuthShell>
      );
    case "signIn":
      return (
        <LoginScreen
          minimal
          note={t("handoff.signInNote")}
          initialEmail={params.email}
          onSubmit={signIn}
          onCreateAccount={() => {}}
          onForgotPassword={() => {}}
          onSso={() => {}}
          error={shown}
          pending={pending}
        />
      );
    case "mfa":
      return (
        <MfaChallengeScreen
          methods={stage.methods}
          onSubmitCode={(method, code) =>
            secondFactor(
              async (mfaToken) => (await (method === "totp" ? verifyTotp : verifyRecoveryCode)(mfaToken, code)).user,
              key("error.verifyFailed"),
            )
          }
          onPasskey={() => secondFactor(verifyPasskey, key("error.passkeyFailedBody"))}
          onCancel={() => {
            setError(null);
            setStage({ kind: "signIn" });
          }}
          error={shown}
          pending={pending}
        />
      );
    case "consent":
      return (
        <AuthShell>
          <h1 style={authStyles.title}>{t("handoff.consentTitle")}</h1>
          <p style={styles.body}>{t("handoff.consentBody", { name: stage.user.name, email: stage.user.email })}</p>
          {shown ? (
            <div style={authStyles.error} role="alert">
              {shown}
            </div>
          ) : null}
          <div style={styles.actions}>
            <Button variant="primary" size="lg" fullWidth disabled={pending} onClick={() => allow(stage.fresh)}>
              {t("prefs.allow")}
            </Button>
            <Button size="lg" fullWidth disabled={pending} onClick={() => void backToApp(`${APP_SIGN_IN}?cancelled=1`, stage.fresh)}>
              {t("common.cancel")}
            </Button>
          </div>
        </AuthShell>
      );
    case "passkey":
      return (
        <AuthShell>
          <h1 style={authStyles.title}>{t("handoff.passkeyTitle")}</h1>
          <p style={styles.body}>{t("handoff.passkeyBody", { email: stage.user.email })}</p>
          {shown ? (
            <div style={authStyles.error} role="alert">
              {shown}
            </div>
          ) : null}
          <div style={styles.actions}>
            <Button variant="primary" size="lg" fullWidth iconLeft="key-round" disabled={pending} onClick={addPasskey}>
              {t("handoff.passkeyTitle")}
            </Button>
            <Button size="lg" fullWidth disabled={pending} onClick={() => void backToApp(APP_PASSKEY, true)}>
              {t("common.cancel")}
            </Button>
          </div>
        </AuthShell>
      );
  }
}
