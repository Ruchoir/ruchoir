"use client";

import { type CSSProperties, type FormEvent, useState } from "react";
import { Button, Field, Icon, Input } from "@/components/ds";
import { AuthShell } from "./AuthShell";
import { authStyles } from "./authStyles";
import { useTranslation } from "@/lib/i18n";

const styles: Record<string, CSSProperties> = {
  body: { fontSize: 14, color: "var(--text-muted)", maxWidth: 340 },
  notice: {
    fontSize: 13,
    lineHeight: 1.5,
    color: "var(--text-muted)",
    padding: "10px 12px",
    background: "var(--surface-sunken)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-md)",
  },
  switcher: {
    display: "flex",
    justifyContent: "center",
    paddingTop: 4,
  },
};

/** Which way back in the screen is offering. */
type Path = "email" | "recovery";

export type ForgotPasswordScreenProps = {
  /** Ask the API to email a reset link for this address. */
  onSubmit: (email: string) => void;
  /** Take the account back with a recovery code, without any message being sent. */
  onRecovery: (values: { email: string; code: string; password: string }) => void;
  onBackToLogin: () => void;
  /** True once the request went through: the screen switches to the neutral confirmation. */
  sent?: boolean;
  /** True once a recovery code has actually changed the password. */
  recovered?: boolean;
  /** Error to surface under the form (the request itself failed, e.g. the API is unreachable). */
  error?: string | null;
  /** True while the request is in flight. */
  pending?: boolean;
  /**
   * Whether this instance has a mail relay. When it has none, the emailed path is not offered at
   * all: it would send someone to wait on a message that is never sent. `undefined` while the
   * capability is still being read, which is treated as "assume email works" so a slow answer
   * never hides the usual path.
   */
  emailDelivery?: boolean;
};

/**
 * Password recovery, by email or by recovery code.
 *
 * The emailed confirmation is deliberately neutral ("if an account exists…"): the API answers the
 * same way whether or not the address is registered, and the screen must not leak what the API
 * withholds. The recovery-code path cannot be neutral in the same way, since it has to say whether
 * the password was changed, and it is protected by the same per-address cooldown as signing in.
 */
export function ForgotPasswordScreen({
  onSubmit,
  onRecovery,
  onBackToLogin,
  sent = false,
  recovered = false,
  error,
  pending = false,
  emailDelivery,
}: ForgotPasswordScreenProps) {
  const { t } = useTranslation();
  const noRelay = emailDelivery === false;
  const [path, setPath] = useState<Path>(noRelay ? "recovery" : "email");
  const [mail, setMail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");

  // An instance that cannot send email has one path, and switching away from it is offering a dead
  // end; the state still exists so the same screen serves both configurations.
  const shownPath: Path = noRelay ? "recovery" : path;

  const submitEmail = (e: FormEvent) => {
    e.preventDefault();
    if (!pending && mail.includes("@")) onSubmit(mail.trim());
  };

  const submitRecovery = (e: FormEvent) => {
    e.preventDefault();
    if (pending || !mail.includes("@") || code.trim().length === 0 || password.length === 0) return;
    onRecovery({ email: mail.trim(), code: code.trim(), password });
  };

  const footer = (
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
  );

  if (recovered) {
    return (
      <AuthShell footer={footer}>
        <div style={authStyles.outcome}>
          <span style={{ ...authStyles.outcomeBadge, background: "var(--surface-sunken)" }}>
            <Icon name="check" size={26} style={{ color: "var(--text-accent)" }} />
          </span>
          <h1 style={authStyles.title}>{t("forgot.recoveredTitle")}</h1>
          <p style={styles.body}>{t("forgot.recoveredBody")}</p>
        </div>
      </AuthShell>
    );
  }

  if (sent && shownPath === "email") {
    return (
      <AuthShell footer={footer}>
        <div style={authStyles.outcome}>
          <span style={{ ...authStyles.outcomeBadge, background: "var(--surface-sunken)" }}>
            <Icon name="mail" size={26} style={{ color: "var(--text-accent)" }} />
          </span>
          <h1 style={authStyles.title}>{t("common.checkInbox")}</h1>
          <p style={styles.body}>{t("forgot.sentBody", { email: mail })}</p>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell footer={footer}>
      <h1 style={authStyles.title}>{t("forgot.title")}</h1>
      <p style={authStyles.subtitle}>
        {shownPath === "email" ? t("forgot.subtitleEmail") : t("forgot.subtitleRecovery")}
      </p>

      {noRelay ? (
        <p style={styles.notice}>{t("forgot.noRelay")}</p>
      ) : null}

      {shownPath === "email" ? (
        <form style={authStyles.fields} onSubmit={submitEmail}>
          <Field label={t("login.email")} htmlFor="fp-mail">
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
            {pending ? t("common.sending") : t("forgot.sendLink")}
          </Button>
        </form>
      ) : (
        <form style={authStyles.fields} onSubmit={submitRecovery}>
          <Field label={t("login.email")} htmlFor="fp-mail-rec">
            <Input
              id="fp-mail-rec"
              size="lg"
              type="email"
              icon="mail"
              autoComplete="email"
              autoFocus
              value={mail}
              onChange={(e) => setMail(e.target.value)}
            />
          </Field>
          <Field label={t("common.recoveryCode")} hint={t("forgot.recoveryHint")} htmlFor="fp-code">
            <Input
              id="fp-code"
              size="lg"
              icon="shield"
              autoComplete="one-time-code"
              spellCheck={false}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </Field>
          <Field label={t("reset.newPassword")} htmlFor="fp-pass">
            <Input
              id="fp-pass"
              size="lg"
              type="password"
              icon="lock"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
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
            disabled={pending || !mail.includes("@") || code.trim().length === 0 || password.length === 0}
          >
            {pending ? t("common.verifying") : t("forgot.reclaim")}
          </Button>
        </form>
      )}

      {noRelay ? null : (
        <div style={styles.switcher}>
          <a
            href="#"
            style={authStyles.link}
            onClick={(e) => {
              e.preventDefault();
              setPath(shownPath === "email" ? "recovery" : "email");
            }}
          >
            {shownPath === "email" ? t("common.useRecoveryCode") : t("forgot.switchToEmail")}
          </a>
        </div>
      )}
    </AuthShell>
  );
}
