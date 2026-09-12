"use client";

import { type CSSProperties, type FormEvent, useState } from "react";
import { Button, Checkbox, Field, Icon, Input } from "@/components/ds";
import { AuthShell } from "./AuthShell";
import { authStyles } from "./authStyles";
import { useTranslation } from "@/lib/i18n";

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

/** Password rules, as a key and the count it interpolates: the sentence is built where it is drawn. */
const RULES: { key: string; count: number; test: (pw: string) => boolean }[] = [
  { key: "signup.minLength", count: MIN_PASSWORD_LENGTH, test: (pw) => pw.length >= MIN_PASSWORD_LENGTH },
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
  const { t } = useTranslation();
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
          {t("signup.haveAccount")}{" "}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              onBackToLogin();
            }}
            style={authStyles.link}
          >
            {t("login.submit")}
          </a>
        </>
      }
    >
      <h1 style={authStyles.title}>{t("signup.title")}</h1>
      <p style={authStyles.subtitle}>{t("signup.subtitle")}</p>
      <form style={authStyles.fields} onSubmit={submit}>
        <div style={styles.nameRow}>
          <Field label={t("signup.firstName")} htmlFor="first" style={{ flex: 1, minWidth: 0 }}>
            <Input id="first" size="lg" value={first} onChange={(e) => setFirst(e.target.value)} autoFocus />
          </Field>
          <Field label={t("signup.lastName")} optional htmlFor="last" style={{ flex: 1, minWidth: 0 }}>
            <Input id="last" size="lg" value={last} onChange={(e) => setLast(e.target.value)} />
          </Field>
        </div>
        <Field label={t("login.email")} htmlFor="s-mail">
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
        <Field label={t("login.password")} htmlFor="s-pw">
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
              <span key={r.key} style={{ ...styles.rule, color: ok ? "var(--status-success-fg)" : "var(--text-subtle)" }}>
                <Icon name={ok ? "check" : "minus"} size={13} />
                {t(r.key, { count: r.count })}
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
          label={<span style={{ fontSize: 13 }}>{t("signup.terms")}</span>}
        />
        <Button variant="primary" size="lg" fullWidth type="submit" disabled={!canSubmit}>
          {pending ? t("signup.submitting") : t("signup.submit")}
        </Button>
      </form>
    </AuthShell>
  );
}
