"use client";

import { type CSSProperties, type FormEvent, useState } from "react";
import { Button, Field, Input } from "@/components/ds";
import type { MfaMethod } from "@/lib/data/api";
import { AuthShell } from "./AuthShell";
import { authStyles } from "./authStyles";
import { useTranslation } from "@/lib/i18n";

const styles: Record<string, CSSProperties> = {
  switcher: { display: "flex", flexDirection: "column", gap: 8, marginTop: 18 },
  switchLabel: {
    fontSize: 11,
    letterSpacing: "var(--tracking-caps)",
    textTransform: "uppercase",
    color: "var(--text-subtle)",
  },
};

/**
 * How each second factor is introduced on the card, as dictionary keys.
 *
 * Keys rather than sentences: this table is built once at module load, where no language is in force
 * yet, and the text is looked up in the component that draws it.
 */
const COPY: Record<MfaMethod, { title: string; subtitle: string; label: string; hint?: string; switchTo: string }> = {
  totp: {
    title: "mfa.totpTitle",
    subtitle: "mfa.totpSubtitle",
    label: "mfa.totpLabel",
    switchTo: "mfa.totpSwitch",
  },
  passkey: {
    title: "mfa.passkeyTitle",
    subtitle: "mfa.passkeySubtitle",
    label: "mfa.passkeyLabel",
    switchTo: "mfa.passkeySwitch",
  },
  recovery: {
    title: "common.recoveryCode",
    subtitle: "mfa.recoverySubtitle",
    label: "common.recoveryCode",
    // The server mints three groups of five characters from an unambiguous alphabet (no 0/O/1/l/i).
    hint: "mfa.recoveryHint",
    switchTo: "common.useRecoveryCode",
  },
};

export type MfaChallengeScreenProps = {
  /** The factors this account can complete, as listed by the login challenge. */
  methods: MfaMethod[];
  /** Submit a typed code for the active method (`totp` or `recovery`). */
  onSubmitCode: (method: "totp" | "recovery", code: string) => void;
  /** Run the passkey ceremony for the pending challenge. */
  onPasskey: () => void;
  /** Abandon the step-up and return to the sign-in form. The pending challenge is dropped. */
  onCancel: () => void;
  /** Error to surface under the form (wrong code, expired challenge, cancelled prompt). */
  error?: string | null;
  /** True while a verification request is in flight. */
  pending?: boolean;
};

/**
 * The second-factor step-up shown when sign-in returns an MFA challenge instead of a session.
 * Offers only the factors the account actually has, starting with the first one the API listed, and
 * lets the user switch to another (a passkey when the phone is out of reach, a recovery code when
 * the authenticator is lost).
 */
export function MfaChallengeScreen({
  methods,
  onSubmitCode,
  onPasskey,
  onCancel,
  error,
  pending = false,
}: MfaChallengeScreenProps) {
  const { t } = useTranslation();
  const [method, setMethod] = useState<MfaMethod>(methods[0] ?? "totp");
  const [code, setCode] = useState("");
  const copy = COPY[method];
  const others = methods.filter((m) => m !== method);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    if (method === "passkey") onPasskey();
    else if (code.trim()) onSubmitCode(method, code.trim());
  };

  return (
    <AuthShell
      footer={
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            onCancel();
          }}
          style={authStyles.link}
        >
          {t("common.backToLogin")}
        </a>
      }
    >
      <h1 style={authStyles.title}>{t(copy.title)}</h1>
      <p style={authStyles.subtitle}>{t(copy.subtitle)}</p>
      <form style={authStyles.fields} onSubmit={submit}>
        {method === "passkey" ? null : (
          <Field label={t(copy.label)} hint={copy.hint ? t(copy.hint) : undefined} htmlFor="mfa-code">
            <Input
              id="mfa-code"
              size="lg"
              icon={method === "totp" ? "shield-check" : "key-round"}
              // A one-time code: let the platform offer it, and never store it in the password manager.
              autoComplete="one-time-code"
              inputMode={method === "totp" ? "numeric" : "text"}
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </Field>
        )}
        {error ? (
          <p style={authStyles.error} role="alert">
            {error}
          </p>
        ) : null}
        <Button
          variant="primary"
          size="lg"
          fullWidth
          type="submit"
          disabled={pending || (method !== "passkey" && code.trim() === "")}
        >
          {pending ? t("common.verifying") : method === "passkey" ? t("mfa.usePasskey") : t("mfa.verify")}
        </Button>
      </form>
      {others.length > 0 ? (
        <div style={styles.switcher}>
          <span style={styles.switchLabel}>{t("mfa.otherMethod")}</span>
          {others.map((other) => (
            <Button
              key={other}
              size="lg"
              fullWidth
              disabled={pending}
              iconLeft={other === "passkey" ? "key-round" : other === "totp" ? "shield-check" : "life-buoy"}
              onClick={() => {
                setMethod(other);
                setCode("");
              }}
            >
              {t(COPY[other].switchTo)}
            </Button>
          ))}
        </div>
      ) : null}
    </AuthShell>
  );
}
