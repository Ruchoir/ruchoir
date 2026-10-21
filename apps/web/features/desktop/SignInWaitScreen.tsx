"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ds";
import { AuthShell } from "@/features/auth/AuthShell";
import { authStyles } from "@/features/auth/authStyles";
import { useTranslation } from "@/lib/i18n";
import { onSignInFailed, signInCancel, signInStart, type InstanceView } from "@/lib/desktop/bridge";

/**
 * Signing in happens on the instance's own page, in the system browser (password, then a code or a
 * passkey), which hands the app a one-time code back. This screen starts it and waits.
 */
export function SignInWaitScreen({ view, onBack }: { view: InstanceView; onBack?: () => void }) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  const host = view.name ?? "";
  const waiting = view.state === "signing_in";

  useEffect(() => {
    const stop = onSignInFailed(() => setFailed(true));
    return () => {
      void stop.then((unlisten) => unlisten());
    };
  }, []);

  const start = () => {
    setFailed(false);
    void signInStart(view.id ?? undefined).catch(() => setFailed(true));
  };

  return (
    <AuthShell>
      <h1 style={authStyles.title}>{waiting ? t("desktop.signIn.waitTitle") : t("desktop.signIn.title", { host })}</h1>
      <p style={authStyles.subtitle}>{waiting ? t("desktop.signIn.waitBody", { host }) : t("desktop.signIn.body", { host })}</p>
      {failed ? (
        <p style={authStyles.error} role="alert">
          {t("desktop.signIn.failed")}
        </p>
      ) : null}
      <div style={authStyles.fields}>
        <Button variant="primary" size="lg" fullWidth onClick={start}>
          {waiting ? t("desktop.signIn.reopen") : t("desktop.signIn.open")}
        </Button>
        {waiting ? (
          <Button variant="ghost" size="lg" fullWidth onClick={() => void signInCancel()}>
            {t("common.cancel")}
          </Button>
        ) : onBack ? (
          <Button variant="ghost" size="lg" fullWidth onClick={onBack}>
            {t("common.back")}
          </Button>
        ) : null}
      </div>
    </AuthShell>
  );
}
