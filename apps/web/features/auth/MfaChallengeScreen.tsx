"use client";

import { type CSSProperties, type FormEvent, useState } from "react";
import { Button, Field, Input } from "@/components/ds";
import type { MfaMethod } from "@/lib/data/api";
import { AuthShell } from "./AuthShell";
import { authStyles } from "./authStyles";

const styles: Record<string, CSSProperties> = {
  switcher: { display: "flex", flexDirection: "column", gap: 8, marginTop: 18 },
  switchLabel: {
    fontSize: 11,
    letterSpacing: "var(--tracking-caps)",
    textTransform: "uppercase",
    color: "var(--text-subtle)",
  },
};

/** How each second factor is introduced on the card. */
const COPY: Record<MfaMethod, { title: string; subtitle: string; label: string; hint?: string; switchTo: string }> = {
  totp: {
    title: "Vérification en deux étapes",
    subtitle: "Saisissez le code à six chiffres affiché par votre application d'authentification.",
    label: "Code de vérification",
    switchTo: "Utiliser un code de vérification",
  },
  passkey: {
    title: "Confirmez avec votre clé d'accès",
    subtitle: "Votre navigateur va vous demander de déverrouiller votre clé d'accès (passkey).",
    label: "Clé d'accès",
    switchTo: "Utiliser une clé d'accès",
  },
  recovery: {
    title: "Code de récupération",
    subtitle: "Saisissez l'un des codes de récupération générés lors de l'activation de la double authentification. Chaque code ne sert qu'une fois.",
    label: "Code de récupération",
    // The server mints three groups of five characters from an unambiguous alphabet (no 0/O/1/l/i).
    hint: "Format : trois groupes de cinq caractères (ex. a2cdf-9fkmp-q34rt)",
    switchTo: "Utiliser un code de récupération",
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
          Revenir à la connexion
        </a>
      }
    >
      <h1 style={authStyles.title}>{copy.title}</h1>
      <p style={authStyles.subtitle}>{copy.subtitle}</p>
      <form style={authStyles.fields} onSubmit={submit}>
        {method === "passkey" ? null : (
          <Field label={copy.label} hint={copy.hint} htmlFor="mfa-code">
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
          {pending ? "Vérification…" : method === "passkey" ? "Utiliser ma clé d'accès" : "Vérifier"}
        </Button>
      </form>
      {others.length > 0 ? (
        <div style={styles.switcher}>
          <span style={styles.switchLabel}>Autre méthode</span>
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
              {COPY[other].switchTo}
            </Button>
          ))}
        </div>
      ) : null}
    </AuthShell>
  );
}
