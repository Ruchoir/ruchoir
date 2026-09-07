"use client";

import type { CSSProperties } from "react";
import { Button, Icon } from "@/components/ds";
import type { InvitationPreview } from "@/lib/data";
import { AuthShell } from "./AuthShell";
import { authStyles } from "./authStyles";

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
            Revenir à la connexion
          </a>
        ) : null
      }
    >
      {status === "loading" ? (
        <div style={authStyles.outcome}>
          <h1 style={authStyles.title}>Vérification de l&apos;invitation…</h1>
          <p style={styles.body}>Nous validons votre lien.</p>
        </div>
      ) : null}

      {status === "joining" ? (
        <div style={authStyles.outcome}>
          <h1 style={authStyles.title}>Ajout à l&apos;espace…</h1>
          <p style={styles.body}>
            Nous vous ajoutons à <span style={styles.space}>{preview?.spaceName}</span>.
          </p>
        </div>
      ) : null}

      {status === "ready" && preview ? (
        <div style={authStyles.outcome}>
          <span style={{ ...authStyles.outcomeBadge, background: "var(--surface-sunken)" }}>
            <Icon name="user-plus" size={26} style={{ color: "var(--text-accent)" }} />
          </span>
          <h1 style={authStyles.title}>Vous êtes invité</h1>
          <p style={styles.body}>
            {preview.invitedBy ? <strong>{preview.invitedBy}</strong> : "Quelqu'un"} vous invite à rejoindre{" "}
            <span style={styles.space}>{preview.spaceName}</span> sur Ruchoir.
          </p>
          {preview.email ? (
            <p style={authStyles.notice}>
              Cette invitation est adressée à <strong>{preview.email}</strong>. Utilisez ce compte, sinon elle sera
              refusée.
            </p>
          ) : null}
          {error ? (
            <p style={authStyles.error} role="alert">
              {error}
            </p>
          ) : null}
          <div style={styles.actions}>
            <Button variant="primary" size="lg" fullWidth onClick={onCreateAccount}>
              Créer un compte
            </Button>
            <Button size="lg" fullWidth onClick={onSignIn}>
              J&apos;ai déjà un compte
            </Button>
          </div>
        </div>
      ) : null}

      {status === "invalid" ? (
        <div style={authStyles.outcome}>
          <span style={{ ...authStyles.outcomeBadge, background: "var(--surface-sunken)" }}>
            <Icon name="info" size={26} style={{ color: "var(--text-muted)" }} />
          </span>
          <h1 style={authStyles.title}>Invitation indisponible</h1>
          <p style={styles.body}>
            Ce lien n&apos;est plus valable : il a peut-être expiré, été révoqué ou déjà servi. Demandez une nouvelle
            invitation à la personne qui vous l&apos;a envoyée.
          </p>
        </div>
      ) : null}
    </AuthShell>
  );
}
