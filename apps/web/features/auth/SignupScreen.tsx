"use client";

import { type CSSProperties, type FormEvent, useState } from "react";
import { Button, Checkbox, Field, Icon, Input } from "@/components/ds";
import { AuthShell } from "./AuthShell";
import { authStyles } from "./authStyles";

const styles: Record<string, CSSProperties> = {
  nameRow: { display: "flex", gap: 10 },
  rules: { display: "flex", flexDirection: "column", gap: 4, marginTop: 2 },
  rule: { display: "flex", alignItems: "center", gap: 6, fontSize: 12 },
};

/**
 * Minimum password length. Mirrors the server policy, which is authoritative: it also rejects
 * passwords found in its offline breach set, which only the server can check.
 */
const MIN_PASSWORD_LENGTH = 12;

const RULES: { label: string; test: (pw: string) => boolean }[] = [
  { label: `Au moins ${MIN_PASSWORD_LENGTH} caractères`, test: (pw) => pw.length >= MIN_PASSWORD_LENGTH },
];

/** The account details submitted to `POST /auth/register`. */
export type SignupValues = { email: string; displayName: string; password: string };

export type SignupScreenProps = {
  /** Create the account. The caller drives the request and the move to the "check your inbox" step. */
  onSubmit: (values: SignupValues) => void;
  onBackToLogin: () => void;
  /** Error to surface under the form (address already taken, password rejected, network). */
  error?: string | null;
  /** True while the registration request is in flight, to disable the form. */
  pending?: boolean;
};

/** Account creation screen. The account stays unverified until the emailed link is confirmed. */
export function SignupScreen({ onSubmit, onBackToLogin, error, pending = false }: SignupScreenProps) {
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [mail, setMail] = useState("");
  const [pw, setPw] = useState("");
  const [agreed, setAgreed] = useState(false);

  const pwValid = RULES.every((r) => r.test(pw));
  const canSubmit = !pending && first.trim() !== "" && mail.includes("@") && pwValid && agreed;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    // The API holds one display name; join the two fields the form collects.
    const displayName = [first.trim(), last.trim()].filter(Boolean).join(" ");
    onSubmit({ email: mail.trim(), displayName, password: pw });
  };

  return (
    <AuthShell
      footer={
        <>
          Déjà un compte ?{" "}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              onBackToLogin();
            }}
            style={authStyles.link}
          >
            Se connecter
          </a>
        </>
      }
    >
      <h1 style={authStyles.title}>Créer votre compte</h1>
      <p style={authStyles.subtitle}>Un compte Ruchoir, hébergé par votre organisation.</p>
      <form style={authStyles.fields} onSubmit={submit}>
        <div style={styles.nameRow}>
          <Field label="Prénom" htmlFor="first" style={{ flex: 1, minWidth: 0 }}>
            <Input id="first" size="lg" value={first} onChange={(e) => setFirst(e.target.value)} autoFocus />
          </Field>
          <Field label="Nom" optional htmlFor="last" style={{ flex: 1, minWidth: 0 }}>
            <Input id="last" size="lg" value={last} onChange={(e) => setLast(e.target.value)} />
          </Field>
        </div>
        <Field label="Adresse électronique" htmlFor="s-mail">
          <Input
            id="s-mail"
            size="lg"
            type="email"
            icon="mail"
            autoComplete="email"
            value={mail}
            onChange={(e) => setMail(e.target.value)}
          />
        </Field>
        <Field label="Mot de passe" htmlFor="s-pw">
          <Input
            id="s-pw"
            size="lg"
            type="password"
            icon="lock"
            autoComplete="new-password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
          />
        </Field>
        <div style={styles.rules}>
          {RULES.map((r) => {
            const ok = r.test(pw);
            return (
              <span key={r.label} style={{ ...styles.rule, color: ok ? "var(--status-success-fg)" : "var(--text-subtle)" }}>
                <Icon name={ok ? "check" : "minus"} size={13} />
                {r.label}
              </span>
            );
          })}
        </div>
        {error ? (
          <p style={authStyles.error} role="alert">
            {error}
          </p>
        ) : null}
        <Checkbox
          checked={agreed}
          onChange={() => setAgreed((a) => !a)}
          label={<span style={{ fontSize: 13 }}>J&apos;accepte les conditions d&apos;utilisation et la politique de confidentialité.</span>}
        />
        <Button variant="primary" size="lg" fullWidth type="submit" disabled={!canSubmit}>
          {pending ? "Création…" : "Créer le compte"}
        </Button>
      </form>
    </AuthShell>
  );
}
