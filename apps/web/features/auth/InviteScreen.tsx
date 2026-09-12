"use client";

import type { CSSProperties } from "react";
import { Button, Icon } from "@/components/ds";
import type { InvitationPreview } from "@/lib/data";
import { AuthShell } from "./AuthShell";
import { authStyles } from "./authStyles";
import { useTranslation } from "@/lib/i18n";

const styles: Record<string, CSSProperties> = {
  body: { fontSize: 14, color: "var(--text-muted)", maxWidth: 340 },
  actions: { display: "flex", flexDirection: "column", gap: 10, width: "100%", marginTop: 4 },
  space: { color: "var(--text-strong)", fontWeight: 600 },
};

/** Where the invitation stands. */
export type InviteStatus =
  /** The token is being resolved against the API. */
  | "loading"
  /** The invitation is valid and waiting for the visitor to sign in or register. */
  | "ready"
  /** The invitation is being accepted for an account that is already signed in. */
  | "joining"
  /** Unknown, revoked, expired or exhausted. The API does not say which, and neither do we. */
  | "invalid";

export type InviteScreenProps = {
  status: InviteStatus;
  /** What the invitation is for. Absent until the preview resolves, and for an invalid one. */
  preview: InvitationPreview | null;
  onSignIn: () => void;
  onCreateAccount: () => void;
  /** Leave the invitation behind and use the app normally. */
  onDismiss: () => void;
  error?: string | null;
};

/**
 * The screen an emailed `/invite?token=…` link lands on.
 *
 * It exists because an invitee arrives with no session and no context: dropping them on a login
 * form would tell them nothing about what they are joining, or even that they were invited at all.
 * The preview is fetched without a session (the API allows exactly that much), so the space name and
 * the inviter are on screen before anyone is asked for a password.
 *
 * An invitation addressed to a specific address says so, because signing in with a different account
 * will be refused by the API and the reason would otherwise be a bare error.
 */
export function InviteScreen({ status, preview, onSignIn, onCreateAccount, onDismiss, error }: InviteScreenProps) {
  const { t } = useTranslation();
  return (
    <AuthShell
      footer={
        status === "invalid" ? (
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              onDismiss();
            }}
            style={authStyles.link}
          >
            {t("common.backToLogin")}
          </a>
        ) : null
      }
    >
      {status === "loading" ? (
        <div style={authStyles.outcome}>
          <h1 style={authStyles.title}>{t("invite.checkingTitle")}</h1>
          <p style={styles.body}>{t("invite.checkingBody")}</p>
        </div>
      ) : null}

      {status === "joining" ? (
        <div style={authStyles.outcome}>
          <h1 style={authStyles.title}>{t("invite.joiningTitle")}</h1>
          <p style={styles.body}>{t("invite.joiningBody", { space: preview?.spaceName ?? "" })}</p>
        </div>
      ) : null}

      {status === "ready" && preview ? (
        <div style={authStyles.outcome}>
          <span style={{ ...authStyles.outcomeBadge, background: "var(--surface-sunken)" }}>
            <Icon name="user-plus" size={26} style={{ color: "var(--text-accent)" }} />
          </span>
          <h1 style={authStyles.title}>{t("invite.readyTitle")}</h1>
          <p style={styles.body}>
            {t("invite.readyBody", {
              who: preview.invitedBy ?? t("invite.someone"),
              space: preview.spaceName,
            })}
          </p>
          {preview.email ? (
            <p style={authStyles.notice}>{t("invite.addressed", { email: preview.email })}</p>
          ) : null}
          {error ? (
            <p style={authStyles.error} role="alert">
              {error}
            </p>
          ) : null}
          <div style={styles.actions}>
            <Button variant="primary" size="lg" fullWidth onClick={onCreateAccount}>
              {t("login.createAccount")}
            </Button>
            <Button size="lg" fullWidth onClick={onSignIn}>
              {t("invite.haveAccount")}
            </Button>
          </div>
        </div>
      ) : null}

      {status === "invalid" ? (
        <div style={authStyles.outcome}>
          <span style={{ ...authStyles.outcomeBadge, background: "var(--surface-sunken)" }}>
            <Icon name="info" size={26} style={{ color: "var(--text-muted)" }} />
          </span>
          <h1 style={authStyles.title}>{t("invite.invalidTitle")}</h1>
          <p style={styles.body}>{t("invite.invalidBody")}</p>
        </div>
      ) : null}
    </AuthShell>
  );
}
