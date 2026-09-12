"use client";

import { type CSSProperties, type FormEvent, useState } from "react";
import { Button, Field, Input } from "@/components/ds";
import { AuthShell } from "./AuthShell";
import { authStyles } from "./authStyles";
import { useTranslation } from "@/lib/i18n";

const styles: Record<string, CSSProperties> = {
  optionRow: { display: "flex", alignItems: "center", justifyContent: "flex-end" },
  divider: { display: "flex", alignItems: "center", gap: 12, margin: "18px 0" },
  dividerLine: { flex: 1, height: 1, background: "var(--border-default)" },
  dividerLabel: {
    fontSize: 11,
    letterSpacing: "var(--tracking-caps)",
    textTransform: "uppercase",
    color: "var(--text-subtle)",
  },
};

export type LoginScreenProps = {
  /** Attempt a sign-in with the entered credentials. AppRoot drives the request and the transition. */
  onSubmit: (email: string, password: string) => void;
  onCreateAccount: () => void;
  /** Open the password-reset request screen. */
  onForgotPassword: () => void;
  /** Single sign-on entry point (OIDC is not enabled server-side yet). */
  onSso: () => void;
  /**
   * Send the verification link again, offered only when the sign-in was refused because the address
   * is not confirmed yet. Receives the address that was entered.
   */
  onResendVerification?: (email: string) => void;
  /** Error to surface under the form (bad credentials, MFA required, network). */
  error?: string | null;
  /** True while a sign-in request is in flight, to disable the form. */
  pending?: boolean;
};

/** The sign-in screen: a centered card, faithful to common team-app login patterns. */
export function LoginScreen({
  onSubmit,
  onCreateAccount,
  onForgotPassword,
  onSso,
  onResendVerification,
  error,
  pending = false,
}: LoginScreenProps) {
  const { t } = useTranslation();
  const [mail, setMail] = useState("");
  const [password, setPassword] = useState("");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    onSubmit(mail.trim(), password);
  };

  return (
    <AuthShell
      footer={
        <>
          {t("login.noAccount")}{" "}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              onCreateAccount();
            }}
            style={{ color: "var(--text-accent)", fontWeight: 500 }}
          >
            {t("login.createAccount")}
          </a>
          <div style={{ marginTop: 10, color: "var(--text-subtle)" }}>{t("login.hosting")}</div>
        </>
      }
    >
      <h1 style={authStyles.title}>{t("login.title")}</h1>
      <p style={authStyles.subtitle}>{t("login.subtitle")}</p>
      <form style={authStyles.fields} onSubmit={submit}>
        <Field label={t("login.email")} htmlFor="mail">
          <Input
            id="mail"
            size="lg"
            type="email"
            icon="mail"
            autoComplete="username"
            value={mail}
            onChange={(e) => setMail(e.target.value)}
          />
        </Field>
        <Field label={t("login.password")} htmlFor="pw">
          <Input
            id="pw"
            size="lg"
            type="password"
            icon="lock"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        {error ? (
          <div style={authStyles.error} role="alert">
            {error}
            {onResendVerification ? (
              <>
                {" "}
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    onResendVerification(mail.trim());
                  }}
                  style={authStyles.link}
                >
                  {t("login.resendVerification")}
                </a>
              </>
            ) : null}
          </div>
        ) : null}
        <div style={styles.optionRow}>
          <a
            href="#"
            style={{ fontSize: 13 }}
            onClick={(e) => {
              e.preventDefault();
              onForgotPassword();
            }}
          >
            {t("login.forgotPassword")}
          </a>
        </div>
        <Button variant="primary" size="lg" fullWidth type="submit" disabled={pending}>
          {pending ? t("login.submitting") : t("login.submit")}
        </Button>
      </form>
      <div style={styles.divider}>
        <span style={styles.dividerLine} />
        <span style={styles.dividerLabel}>{t("login.or")}</span>
        <span style={styles.dividerLine} />
      </div>
      <Button size="lg" fullWidth iconLeft="key-round" onClick={onSso} disabled={pending}>
        {t("login.sso")}
      </Button>
    </AuthShell>
  );
}
