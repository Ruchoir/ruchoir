"use client";

import { type CSSProperties, type FormEvent, useState } from "react";
import { Button, Checkbox, Field, Input } from "@/components/ds";
import { AuthShell } from "./AuthShell";
import { authStyles } from "./authStyles";

const styles: Record<string, CSSProperties> = {
  optionRow: { display: "flex", alignItems: "center", justifyContent: "space-between" },
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
  const [server, setServer] = useState("");
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
          Pas encore de compte ?{" "}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              onCreateAccount();
            }}
            style={{ color: "var(--text-accent)", fontWeight: 500 }}
          >
            Créer un compte
          </a>
          <div style={{ marginTop: 10, color: "var(--text-subtle)" }}>Hébergement en France, données chez vous.</div>
        </>
      }
    >
      <h1 style={authStyles.title}>Connexion</h1>
      <p style={authStyles.subtitle}>Connectez-vous au serveur de votre organisation.</p>
      <form style={authStyles.fields} onSubmit={submit}>
        <Field label="Serveur" hint="Adresse fournie par votre administrateur" htmlFor="srv">
          <Input
            id="srv"
            size="lg"
            icon="server"
            placeholder="atelier.exemple.fr"
            value={server}
            onChange={(e) => setServer(e.target.value)}
          />
        </Field>
        <Field label="Adresse électronique" htmlFor="mail">
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
        <Field label="Mot de passe" htmlFor="pw">
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
                  Renvoyer le lien de confirmation
                </a>
              </>
            ) : null}
          </div>
        ) : null}
        <div style={styles.optionRow}>
          <Checkbox label="Rester connecté" defaultChecked />
          <a
            href="#"
            style={{ fontSize: 13 }}
            onClick={(e) => {
              e.preventDefault();
              onForgotPassword();
            }}
          >
            Mot de passe oublié ?
          </a>
        </div>
        <Button variant="primary" size="lg" fullWidth type="submit" disabled={pending}>
          {pending ? "Connexion…" : "Se connecter"}
        </Button>
      </form>
      <div style={styles.divider}>
        <span style={styles.dividerLine} />
        <span style={styles.dividerLabel}>ou</span>
        <span style={styles.dividerLine} />
      </div>
      <Button size="lg" fullWidth iconLeft="key-round" onClick={onSso} disabled={pending}>
        Authentification unique (SSO)
      </Button>
    </AuthShell>
  );
}
