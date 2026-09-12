"use client";

import { type CSSProperties, type FormEvent, useState } from "react";
import { Button, Field, Icon, Input } from "@/components/ds";
import { AuthShell } from "./AuthShell";
import { authStyles } from "./authStyles";
import { useTranslation } from "@/lib/i18n";

const styles: Record<string, CSSProperties> = {
  body: { fontSize: 14, color: "var(--text-muted)", maxWidth: 340 },
};

/** Minimum password length. Mirrors the server policy, which stays authoritative (breach check). */
const MIN_PASSWORD_LENGTH = 12;

export type ResetPasswordScreenProps = {
  /** Set the new password behind the emailed token. The caller holds the token. */
  onSubmit: (password: string) => void;
  onBackToLogin: () => void;
  /** True once the password has been changed: every previous session was dropped server-side. */
  done?: boolean;
  /** Error to surface under the form (expired link, password rejected by the policy). */
  error?: string | null;
  /** True while the request is in flight. */
  pending?: boolean;
};

/**
 * New-password screen, reached from the emailed `/reset-password?token=…` link. Changing the
 * password invalidates every existing session, so the user signs in again afterwards.
 */
export function ResetPasswordScreen({
  onSubmit,
  onBackToLogin,
  done = false,
  error,
  pending = false,
}: ResetPasswordScreenProps) {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;
  const mismatch = confirm.length > 0 && confirm !== password;
  const canSubmit = !pending && password.length >= MIN_PASSWORD_LENGTH && confirm === password;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (canSubmit) onSubmit(password);
  };

  return (
    <AuthShell
      footer={
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            onBackToLogin();
          }}
          style={authStyles.link}
        >
          {t("common.backToLogin")}
        </a>
      }
    >
      {done ? (
        <div style={authStyles.outcome}>
          <span style={{ ...authStyles.outcomeBadge, background: "var(--status-success-bg)" }}>
            <Icon name="check" size={26} style={{ color: "var(--status-success-fg)" }} />
          </span>
          <h1 style={authStyles.title}>{t("reset.doneTitle")}</h1>
          <p style={styles.body}>{t("reset.doneBody")}</p>
          <Button variant="primary" size="lg" fullWidth onClick={onBackToLogin}>
            {t("login.submit")}
          </Button>
        </div>
      ) : (
        <>
          <h1 style={authStyles.title}>{t("reset.title")}</h1>
          <p style={authStyles.subtitle}>{t("reset.subtitle", { count: MIN_PASSWORD_LENGTH })}</p>
          <form style={authStyles.fields} onSubmit={submit}>
            <Field
              label={t("reset.newPassword")}
              htmlFor="rp-pw"
              error={tooShort ? t("reset.tooShort", { count: MIN_PASSWORD_LENGTH }) : undefined}
            >
              <Input
                id="rp-pw"
                size="lg"
                type="password"
                icon="lock"
                autoComplete="new-password"
                autoFocus
                invalid={tooShort}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <Field
              label={t("reset.confirmPassword")}
              htmlFor="rp-pw2"
              error={mismatch ? t("reset.mismatch") : undefined}
            >
              <Input
                id="rp-pw2"
                size="lg"
                type="password"
                icon="lock"
                autoComplete="new-password"
                invalid={mismatch}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </Field>
            {error ? (
              <p style={authStyles.error} role="alert">
                {error}
              </p>
            ) : null}
            <Button variant="primary" size="lg" fullWidth type="submit" disabled={!canSubmit}>
              {pending ? t("reset.submitting") : t("reset.submit")}
            </Button>
          </form>
        </>
      )}
    </AuthShell>
  );
}
