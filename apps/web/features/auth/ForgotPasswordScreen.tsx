"use client";

import { type CSSProperties, type FormEvent, useState } from "react";
import { Button, Field, Icon, Input } from "@/components/ds";
import { AuthShell } from "./AuthShell";
import { authStyles } from "./authStyles";

const styles: Record<string, CSSProperties> = {
  body: { fontSize: 14, color: "var(--text-muted)", maxWidth: 340 },
};

export type ForgotPasswordScreenProps = {
  /** Ask the API to email a reset link for this address. */
  onSubmit: (email: string) => void;
  onBackToLogin: () => void;
  /** True once the request went through: the screen switches to the neutral confirmation. */
  sent?: boolean;
  /** Error to surface under the form (the request itself failed, e.g. the API is unreachable). */
  error?: string | null;
  /** True while the request is in flight. */
  pending?: boolean;
};

/**
 * Password-reset request. The confirmation is deliberately neutral ("if an account exists…"): the
 * API answers the same way whether or not the address is registered, and the screen must not leak
 * what the API withholds.
 */
export function ForgotPasswordScreen({
  onSubmit,
  onBackToLogin,
  sent = false,
  error,
  pending = false,
}: ForgotPasswordScreenProps) {
  const [mail, setMail] = useState("");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!pending && mail.includes("@")) onSubmit(mail.trim());
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
      {sent ? (
        <div style={authStyles.outcome}>
          <span style={{ ...authStyles.outcomeBadge, background: "var(--surface-sunken)" }}>
            <Icon name="mail" size={26} style={{ color: "var(--text-accent)" }} />
          </span>
          <h1 style={authStyles.title}>Vérifiez votre boîte mail</h1>
          <p style={styles.body}>
            Si un compte existe pour <strong>{mail}</strong>, un lien de réinitialisation vient d&apos;être envoyé. Il
            expire au bout de quelques minutes.
          </p>
        </div>
      ) : (
        <>
          <h1 style={authStyles.title}>Mot de passe oublié</h1>
          <p style={authStyles.subtitle}>
            Indiquez l&apos;adresse de votre compte : nous vous enverrons un lien pour choisir un nouveau mot de passe.
          </p>
          <form style={authStyles.fields} onSubmit={submit}>
            <Field label="Adresse électronique" htmlFor="fp-mail">
              <Input
                id="fp-mail"
                size="lg"
                type="email"
                icon="mail"
                autoComplete="email"
                autoFocus
                value={mail}
                onChange={(e) => setMail(e.target.value)}
              />
            </Field>
            {error ? (
              <p style={authStyles.error} role="alert">
                {error}
              </p>
            ) : null}
            <Button variant="primary" size="lg" fullWidth type="submit" disabled={pending || !mail.includes("@")}>
              {pending ? "Envoi…" : "Envoyer le lien"}
            </Button>
          </form>
        </>
      )}
    </AuthShell>
  );
}
