import { type CSSProperties, type ReactNode, useState } from "react";
import { Button, Icon, Tag } from "@/components/ds";
import { logoutEverywhere } from "@/lib/data/api";
import type { Toast } from "./types";

/**
 * Account security, as it actually stands.
 *
 * This section used to offer a password change, two-factor enrolment, recovery codes and passkeys.
 * None of it reached the server. Changing the password raised a success message and changed
 * nothing; enabling two-factor authentication wrote a flag into this browser's local storage;
 * the recovery codes were computed in the page from a counter, so someone who wrote them down had
 * written down nothing. The module that produced them said as much in its own header, where only a
 * developer would read it.
 *
 * A screen that tells someone their account is protected when it is not is worse than a screen that
 * offers nothing, so it now says what is true. The pieces are not far off: the API already
 * challenges a second factor at sign-in and holds the tables for secrets, recovery codes and
 * credentials. What is missing is enrolment from here, and three routes to go with it (read the
 * state, turn it off, remove a key).
 */

const row: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 14,
  padding: "14px 0",
  borderBottom: "1px solid var(--border-subtle)",
};

function Row({ title, desc, children }: { title: string; desc: ReactNode; children: ReactNode }) {
  return (
    <div style={row}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-strong)" }}>{title}</div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2, maxWidth: 520 }}>{desc}</div>
      </div>
      {children}
    </div>
  );
}

export function AccountSecuritySection({
  onNotify,
  onSignedOut,
}: {
  onNotify?: (t: Toast) => void;
  /** Called once every session is gone, so the app can return to the sign-in screen. */
  onSignedOut?: () => void;
}) {
  const [signingOut, setSigningOut] = useState(false);

  const signOutEverywhere = () => {
    setSigningOut(true);
    logoutEverywhere()
      .then(() => onSignedOut?.())
      .catch(() => {
        setSigningOut(false);
        onNotify?.({ tone: "danger", title: "Déconnexion impossible", description: "Réessayez dans un instant." });
      });
  };

  return (
    <>
      <div
        style={{
          display: "flex",
          gap: 10,
          padding: 12,
          marginBottom: 4,
          borderRadius: "var(--radius-md)",
          background: "var(--surface-sunken)",
          fontSize: 12,
          color: "var(--text-body)",
          lineHeight: "var(--leading-snug)",
        }}
      >
        <Icon name="info" size={15} style={{ color: "var(--text-muted)", flex: "none", marginTop: 1 }} />
        <span>
          La sécurité du compte se règle pour l&apos;instant en dehors de cet écran. Votre mot de passe
          protège votre session ; les moyens ci-dessous arrivent.
        </span>
      </div>

      <Row
        title="Mot de passe"
        desc={
          <>
            Modifiable par le lien <strong>« Mot de passe oublié ? »</strong> de l&apos;écran de connexion,
            qui envoie un lien à votre adresse. Le changer depuis l&apos;application, en connaissant
            l&apos;ancien, viendra avec les écrans de sécurité.
          </>
        }
      >
        <Tag tone="neutral">Par courriel</Tag>
      </Row>

      <Row
        title="Authentification à deux facteurs"
        desc="Le serveur sait déjà la demander à la connexion. L'inscription d'une application d'authentification depuis cet écran n'existe pas encore."
      >
        <Tag tone="neutral">Bientôt</Tag>
      </Row>

      <Row
        title="Codes de récupération"
        desc="Ils accompagnent la double authentification : de quoi entrer si vous perdez votre téléphone."
      >
        <Tag tone="neutral">Bientôt</Tag>
      </Row>

      <Row
        title="Sessions"
        desc="Si vous pensez qu'un autre appareil est resté connecté, coupez tout : chaque session est fermée, y compris celle-ci, et vous vous reconnectez ici."
      >
        <Button size="sm" variant="danger" disabled={signingOut} onClick={signOutEverywhere}>
          {signingOut ? "Déconnexion…" : "Se déconnecter partout"}
        </Button>
      </Row>

      <Row
        title="Clés d'accès (passkeys)"
        desc="Connexion par empreinte, visage ou code de l'appareil. Reconnues à la connexion ; leur enregistrement depuis cet écran reste à faire."
      >
        <Tag tone="neutral">Bientôt</Tag>
      </Row>
    </>
  );
}
