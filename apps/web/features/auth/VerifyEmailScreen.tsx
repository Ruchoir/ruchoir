"use client";

import { type CSSProperties, type FormEvent, useState } from "react";
import { Button, Field, Icon, Input } from "@/components/ds";
import { AuthShell } from "./AuthShell";
import { authStyles } from "./authStyles";

const styles: Record<string, CSSProperties> = {
  body: { fontSize: 14, color: "var(--text-muted)", maxWidth: 340 },
  actions: { display: "flex", flexDirection: "column", gap: 10, width: "100%", marginTop: 4 },
};

/** Where the address confirmation stands. */
export type VerifyEmailStatus =
  /** The link was just emailed (after registration, or after a resend): nothing to do here yet. */
  | "sent"
  /** The emailed token is being confirmed against the API. */
  | "verifying"
  /** The address is confirmed: the account can sign in. */
  | "done"
  /** The token was missing, expired or already used. */
  | "error";

export type VerifyEmailScreenProps = {
  status: VerifyEmailStatus;
  /** The address awaiting confirmation, when known (it is not carried by the emailed link). */
  email?: string;
  /** Ask for a fresh link. The address comes from the sign-up step, or from the field shown on failure. */
  onResend: (email: string) => void;
  onBackToLogin: () => void;
  /** Why the confirmation failed, for the `error` status. */
  error?: string | null;
  /** True while a resend request is in flight. */
  pending?: boolean;
  /** True once a fresh link has been sent from this screen. */
  resent?: boolean;
};

/**
 * Email-address confirmation. It serves both ends of the flow: the notice shown right after
 * registration ("check your inbox"), and the screen the emailed `/verify-email?token=…` link lands
 * on, which confirms the token and offers a new link when it has expired.
 */
export function VerifyEmailScreen({
  status,
  email,
  onResend,
  onBackToLogin,
  error,
  pending = false,
  resent = false,
}: VerifyEmailScreenProps) {
  const [typedEmail, setTypedEmail] = useState(email ?? "");

  const resend = (e: FormEvent) => {
    e.preventDefault();
    const address = (email ?? typedEmail).trim();
    if (!pending && address.includes("@")) onResend(address);
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
      {status === "verifying" ? (
        <div style={authStyles.outcome}>
          <h1 style={authStyles.title}>Confirmation en cours…</h1>
          <p style={styles.body}>Nous validons votre lien de confirmation.</p>
        </div>
      ) : null}

      {status === "done" ? (
        <div style={authStyles.outcome}>
          <span style={{ ...authStyles.outcomeBadge, background: "var(--status-success-bg)" }}>
            <Icon name="check" size={26} style={{ color: "var(--status-success-fg)" }} />
          </span>
          <h1 style={authStyles.title}>Adresse confirmée</h1>
          <p style={styles.body}>Votre compte est actif. Connectez-vous pour entrer dans votre espace.</p>
          <Button variant="primary" size="lg" fullWidth onClick={onBackToLogin}>
            Se connecter
          </Button>
        </div>
      ) : null}

      {status === "sent" ? (
        <div style={authStyles.outcome}>
          <span style={{ ...authStyles.outcomeBadge, background: "var(--surface-sunken)" }}>
            <Icon name="mail" size={26} style={{ color: "var(--text-accent)" }} />
          </span>
          <h1 style={authStyles.title}>Vérifiez votre boîte mail</h1>
          <p style={styles.body}>
            Un lien de confirmation a été envoyé{email ? " à " : ""}
            {email ? <strong>{email}</strong> : ""}. Ouvrez-le pour activer votre compte, puis connectez-vous.
          </p>
          {resent ? (
            <p style={authStyles.notice} role="status">
              Un nouveau lien vient d&apos;être envoyé.
            </p>
          ) : null}
          <form style={styles.actions} onSubmit={resend}>
            <Button size="lg" fullWidth type="submit" iconLeft="refresh-cw" disabled={pending}>
              {pending ? "Envoi…" : "Renvoyer le lien"}
            </Button>
          </form>
        </div>
      ) : null}

      {status === "error" ? (
        <>
          <h1 style={authStyles.title}>Lien de confirmation invalide</h1>
          <p style={authStyles.subtitle}>
            {error ?? "Ce lien est invalide ou a expiré."} Indiquez votre adresse pour en recevoir un nouveau.
          </p>
          <form style={authStyles.fields} onSubmit={resend}>
            <Field label="Adresse électronique" htmlFor="verify-mail">
              <Input
                id="verify-mail"
                size="lg"
                type="email"
                icon="mail"
                autoComplete="email"
                value={typedEmail}
                onChange={(e) => setTypedEmail(e.target.value)}
              />
            </Field>
            {resent ? (
              <p style={authStyles.notice} role="status">
                Si cette adresse correspond à un compte en attente, un nouveau lien vient d&apos;être envoyé.
              </p>
            ) : null}
            <Button
              variant="primary"
              size="lg"
              fullWidth
              type="submit"
              disabled={pending || !typedEmail.includes("@")}
            >
              {pending ? "Envoi…" : "Renvoyer le lien"}
            </Button>
          </form>
        </>
      ) : null}
    </AuthShell>
  );
}
