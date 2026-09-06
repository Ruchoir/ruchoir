"use client";

import { type CSSProperties, type FormEvent, useState } from "react";
import { Button, Field, Icon, Input } from "@/components/ds";
import { AuthShell } from "./AuthShell";
import { authStyles } from "./authStyles";

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
          Revenir à la connexion
        </a>
      }
    >
      {done ? (
        <div style={authStyles.outcome}>
          <span style={{ ...authStyles.outcomeBadge, background: "var(--status-success-bg)" }}>
            <Icon name="check" size={26} style={{ color: "var(--status-success-fg)" }} />
          </span>
          <h1 style={authStyles.title}>Mot de passe modifié</h1>
          <p style={styles.body}>
            Vos autres sessions ont été fermées. Connectez-vous avec votre nouveau mot de passe.
          </p>
          <Button variant="primary" size="lg" fullWidth onClick={onBackToLogin}>
            Se connecter
          </Button>
        </div>
      ) : (
        <>
          <h1 style={authStyles.title}>Choisir un nouveau mot de passe</h1>
          <p style={authStyles.subtitle}>
            Au moins {MIN_PASSWORD_LENGTH} caractères. Évitez un mot de passe déjà utilisé ailleurs.
          </p>
          <form style={authStyles.fields} onSubmit={submit}>
            <Field
              label="Nouveau mot de passe"
              htmlFor="rp-pw"
              error={tooShort ? `Au moins ${MIN_PASSWORD_LENGTH} caractères.` : undefined}
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
              label="Confirmer le mot de passe"
              htmlFor="rp-pw2"
              error={mismatch ? "Les deux mots de passe ne correspondent pas." : undefined}
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
              {pending ? "Enregistrement…" : "Enregistrer le mot de passe"}
            </Button>
          </form>
        </>
      )}
    </AuthShell>
  );
}
