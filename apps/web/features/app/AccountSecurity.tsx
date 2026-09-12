import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { Button, Dialog, Field, Icon, Input, Tag } from "@/components/ds";
import {
  changePassword,
  confirmTotp,
  disableTotp,
  enrollTotp,
  generateRecoveryCodes,
  getMfaState,
  logoutEverywhere,
  registerPasskey,
  removePasskey,
  type MfaState,
} from "@/lib/data/api";
import { apiErrorCode, isApiError } from "@/lib/data/http";
import { isPasskeySupported } from "@/lib/webauthn";
import type { Toast } from "./types";

/**
 * Account security, wired to the account rather than to this browser.
 *
 * Everything here used to live in local storage: enabling two-factor authentication set a flag,
 * the recovery codes were computed in the page from a counter, and the passkeys were invented
 * entries. Someone reading the screen came away believing their account was protected.
 *
 * One source now, `GET /auth/mfa`, re-read after every change. Nothing on screen is derived from
 * what happened in this tab: the answer to "am I protected" is the server's.
 */

const row: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 14,
  padding: "14px 0",
  borderBottom: "1px solid var(--border-subtle)",
};

function Row({ title, desc, children }: { title: ReactNode; desc?: ReactNode; children?: ReactNode }) {
  return (
    <div style={row}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-strong)" }}>{title}</div>
        {desc ? (
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2, maxWidth: 520 }}>{desc}</div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

/**
 * The codes, shown once and never again.
 *
 * Displayed in a monospaced grid because they are transcribed by hand as often as copied, and a
 * proportional font turns a zero into an O at exactly the wrong moment.
 */
function RecoveryCodes({ codes, onNotify }: { codes: string[]; onNotify?: (t: Toast) => void }) {
  return (
    <>
      <p style={{ fontSize: 13, color: "var(--text-body)", lineHeight: "var(--leading-normal)" }}>
        Gardez-les hors de votre téléphone : ils servent précisément le jour où vous ne l&apos;avez plus.
        Chacun ne fonctionne qu&apos;une fois, et cette liste ne sera plus affichée.
      </p>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
          gap: 8,
          margin: "14px 0",
          padding: 12,
          borderRadius: "var(--radius-md)",
          background: "var(--surface-sunken)",
          fontFamily: "var(--font-mono)",
          fontSize: 13,
          color: "var(--text-strong)",
        }}
      >
        {codes.map((code) => (
          <span key={code}>{code}</span>
        ))}
      </div>
      <Button
        size="sm"
        iconLeft="copy"
        onClick={() => {
          void navigator.clipboard?.writeText(codes.join("\n"));
          onNotify?.({ tone: "success", title: "Codes copiés" });
        }}
      >
        Copier
      </Button>
    </>
  );
}

type OpenDialog = "totp" | "disable" | "recovery" | "password" | null;

export function AccountSecuritySection({
  onNotify,
  onSignedOut,
}: {
  onNotify?: (t: Toast) => void;
  /** Called when every session has ended, so the app returns to the sign-in screen. */
  onSignedOut?: () => void;
}) {
  const [state, setState] = useState<MfaState | null>(null);
  const [open, setOpen] = useState<OpenDialog>(null);
  const [busy, setBusy] = useState(false);

  // Enrolment, held only while its dialog is open: the secret behind the QR is useless once
  // confirmed, and keeping it around would be keeping a second copy of a secret for no reason.
  const [enrolment, setEnrolment] = useState<{ otpauthUrl: string; qrSvg: string } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    getMfaState()
      .then((next) => active && setState(next))
      .catch(() => {
        // Left as unknown rather than guessed at: the rows say "…" until the account answers.
      });
    return () => {
      active = false;
    };
  }, [reload]);
  const refresh = () => setReload((n) => n + 1);

  const close = () => {
    setOpen(null);
    setEnrolment(null);
    setCode("");
    setCodes(null);
    setPassword("");
    setNewPassword("");
    setError(null);
    setBusy(false);
  };

  const startTotp = () => {
    setOpen("totp");
    setBusy(true);
    enrollTotp()
      .then((next) => {
        setEnrolment(next);
        setBusy(false);
      })
      .catch(() => {
        close();
        onNotify?.({ tone: "danger", title: "Configuration impossible", description: "Réessayez dans un instant." });
      });
  };

  const finishTotp = () => {
    setBusy(true);
    setError(null);
    confirmTotp(code.trim())
      .then(() => generateRecoveryCodes())
      .then((fresh) => {
        // Straight to the codes: enabling a second factor without one is how people lock
        // themselves out, and the only moment they can be shown is now.
        setEnrolment(null);
        setCodes(fresh);
        setOpen("recovery");
        setBusy(false);
        refresh();
        onNotify?.({ tone: "success", title: "Double authentification activée" });
      })
      .catch(() => {
        setBusy(false);
        setError("Ce code n'est pas le bon. Il change toutes les trente secondes.");
      });
  };

  const confirmDisable = () => {
    setBusy(true);
    setError(null);
    disableTotp(password)
      .then(() => {
        close();
        refresh();
        onNotify?.({ tone: "info", title: "Double authentification désactivée" });
      })
      .catch((err) => {
        setBusy(false);
        setError(isApiError(err, 401) ? "Mot de passe incorrect." : "Réessayez dans un instant.");
      });
  };

  const showNewCodes = () => {
    setBusy(true);
    generateRecoveryCodes()
      .then((fresh) => {
        setCodes(fresh);
        setOpen("recovery");
        setBusy(false);
        refresh();
      })
      .catch(() => {
        setBusy(false);
        onNotify?.({ tone: "danger", title: "Génération impossible" });
      });
  };

  const addPasskey = () => {
    setBusy(true);
    registerPasskey()
      .then(() => {
        setBusy(false);
        refresh();
        onNotify?.({ tone: "success", title: "Clé d'accès enregistrée" });
      })
      .catch((err) => {
        setBusy(false);
        // A dismissed prompt is a decision, not a failure, and the browser reports it the same way.
        const cancelled = err instanceof Error && err.name === "NotAllowedError";
        if (cancelled) return;
        onNotify?.({ tone: "danger", title: "Clé d'accès non enregistrée", description: "Réessayez dans un instant." });
      });
  };

  const dropPasskey = (id: string) => {
    removePasskey(id)
      .then(() => {
        refresh();
        onNotify?.({ tone: "info", title: "Clé d'accès retirée" });
      })
      .catch(() => onNotify?.({ tone: "danger", title: "Suppression impossible" }));
  };

  const submitPassword = () => {
    setBusy(true);
    setError(null);
    changePassword(password, newPassword)
      .then(() => onSignedOut?.())
      .catch((err) => {
        setBusy(false);
        if (isApiError(err, 401)) {
          setError("Mot de passe actuel incorrect.");
          return;
        }
        const code = apiErrorCode(err);
        setError(
          code === "breached_password"
            ? "Ce mot de passe figure dans des fuites connues. Choisissez-en un autre."
            : "Ce mot de passe est trop faible : au moins douze caractères.",
        );
      });
  };

  const signOutEverywhere = () => {
    setBusy(true);
    logoutEverywhere()
      .then(() => onSignedOut?.())
      .catch(() => {
        setBusy(false);
        onNotify?.({ tone: "danger", title: "Déconnexion impossible", description: "Réessayez dans un instant." });
      });
  };

  const unknown = state === null;
  const codesLeft = state?.recoveryCodesRemaining ?? 0;

  return (
    <>
      <Row title="Mot de passe" desc="Le changer met fin à toutes vos sessions, celle-ci comprise.">
        <Button size="sm" onClick={() => setOpen("password")}>
          Modifier
        </Button>
      </Row>

      <Row
        title={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            Authentification à deux facteurs
            {unknown ? null : state.totpEnabled ? (
              <Tag tone="success" icon="shield-check">
                Activée
              </Tag>
            ) : (
              <Tag tone="neutral">Désactivée</Tag>
            )}
          </span>
        }
        desc={
          unknown
            ? "…"
            : state.totpEnabled
              ? "Une application d'authentification est enregistrée sur ce compte."
              : "Un code à usage unique, en plus du mot de passe, demandé à chaque connexion."
        }
      >
        {unknown ? null : state.totpEnabled ? (
          <Button size="sm" onClick={() => setOpen("disable")}>
            Désactiver
          </Button>
        ) : (
          <Button size="sm" variant="primary" onClick={startTotp}>
            Configurer
          </Button>
        )}
      </Row>

      {state?.totpEnabled ? (
        <Row
          title="Codes de récupération"
          desc={
            codesLeft > 0
              ? `${codesLeft} code${codesLeft > 1 ? "s" : ""} inutilisé${codesLeft > 1 ? "s" : ""}. En générer de nouveaux annule les précédents.`
              : "Aucun code disponible. Sans eux, perdre votre téléphone ferme le compte."
          }
        >
          <Button size="sm" variant={codesLeft > 0 ? "secondary" : "primary"} disabled={busy} onClick={showNewCodes}>
            {codesLeft > 0 ? "Regénérer" : "Générer"}
          </Button>
        </Row>
      ) : null}

      <Row
        title={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            Clés d&apos;accès (passkeys)
            {unknown ? null : <Tag tone="info">{state.passkeys.length}</Tag>}
          </span>
        }
        desc={
          isPasskeySupported()
            ? "Connexion par empreinte, visage ou code de l'appareil, sans mot de passe."
            : "Ce navigateur ne les propose pas. Sur un appareil qui les gère, la connexion se fait par empreinte ou par visage."
        }
      >
        <Button size="sm" iconLeft="plus" disabled={busy || !isPasskeySupported()} onClick={addPasskey}>
          Ajouter
        </Button>
      </Row>

      {state && state.passkeys.length > 0 ? (
        <div style={{ padding: "12px 0 4px", display: "flex", flexDirection: "column", gap: 6 }}>
          {state.passkeys.map((key) => (
            <div
              key={key.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 10px",
                borderRadius: "var(--radius-sm)",
                background: "var(--surface-sunken)",
                fontSize: 13,
              }}
            >
              <Icon name="key-round" size={14} style={{ color: "var(--text-muted)" }} />
              <span style={{ flex: 1, minWidth: 0, color: "var(--text-strong)" }}>
                {key.label ?? "Clé d'accès"}
              </span>
              <span style={{ fontSize: 12, color: "var(--text-subtle)" }}>
                {key.lastUsedAt
                  ? `utilisée le ${new Date(key.lastUsedAt).toLocaleDateString("fr-FR")}`
                  : `ajoutée le ${new Date(key.createdAt).toLocaleDateString("fr-FR")}`}
              </span>
              <Button size="sm" variant="ghost" onClick={() => dropPasskey(key.id)}>
                Retirer
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      <Row
        title="Sessions"
        desc="Si vous pensez qu'un autre appareil est resté connecté, coupez tout : chaque session est fermée, y compris celle-ci."
      >
        <Button size="sm" variant="danger" disabled={busy} onClick={signOutEverywhere}>
          Se déconnecter partout
        </Button>
      </Row>

      <Dialog
        open={open === "totp"}
        title="Configurer la double authentification"
        subtitle="Scannez ce code avec votre application d'authentification, puis saisissez le code qu'elle affiche."
        size="sm"
        onClose={close}
        footer={
          <>
            <Button onClick={close}>Annuler</Button>
            <Button variant="primary" disabled={busy || code.trim().length < 6} onClick={finishTotp}>
              {busy ? "Vérification…" : "Activer"}
            </Button>
          </>
        }
      >
        {enrolment ? (
          <>
            {/* The SVG is built by the server from the same URI shown below it, so the two cannot
                disagree, and no QR library is loaded in the browser. */}
            <div
              style={{ display: "flex", justifyContent: "center", padding: 8 }}
              dangerouslySetInnerHTML={{ __html: enrolment.qrSvg }}
            />
            <p style={{ fontSize: 12, color: "var(--text-muted)", wordBreak: "break-all", margin: "8px 0 16px" }}>
              Impossible de scanner ? Saisissez cette adresse dans votre application : {enrolment.otpauthUrl}
            </p>
          </>
        ) : (
          <p style={{ fontSize: 13, color: "var(--text-muted)" }}>Préparation…</p>
        )}
        <Field label="Code à six chiffres" htmlFor="totp-code" error={error ?? undefined}>
          <Input
            id="totp-code"
            autoFocus
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && code.trim().length >= 6) finishTotp();
            }}
          />
        </Field>
      </Dialog>

      <Dialog
        open={open === "disable"}
        title="Désactiver la double authentification ?"
        size="sm"
        onClose={close}
        footer={
          <>
            <Button onClick={close}>Annuler</Button>
            <Button variant="danger" disabled={busy || !password} onClick={confirmDisable}>
              Désactiver
            </Button>
          </>
        }
      >
        <p style={{ fontSize: 13, color: "var(--text-body)", marginBottom: 14 }}>
          Votre compte ne sera plus protégé que par son mot de passe.
        </p>
        <Field label="Votre mot de passe" htmlFor="disable-pw" error={error ?? undefined}>
          <Input
            id="disable-pw"
            type="password"
            autoFocus
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
      </Dialog>

      <Dialog
        open={open === "recovery"}
        title="Codes de récupération"
        size="sm"
        onClose={close}
        footer={
          <Button variant="primary" onClick={close}>
            Je les ai notés
          </Button>
        }
      >
        {codes ? <RecoveryCodes codes={codes} onNotify={onNotify} /> : null}
      </Dialog>

      <Dialog
        open={open === "password"}
        title="Modifier le mot de passe"
        size="sm"
        onClose={close}
        footer={
          <>
            <Button onClick={close}>Annuler</Button>
            <Button variant="primary" disabled={busy || !password || !newPassword} onClick={submitPassword}>
              {busy ? "Enregistrement…" : "Modifier"}
            </Button>
          </>
        }
      >
        <p style={{ fontSize: 13, color: "var(--text-body)", marginBottom: 14 }}>
          Toutes vos sessions seront fermées, y compris celle-ci : vous vous reconnecterez avec le
          nouveau mot de passe.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Field label="Mot de passe actuel" htmlFor="pw-old">
            <Input
              id="pw-old"
              type="password"
              autoFocus
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Field label="Nouveau mot de passe" htmlFor="pw-new" error={error ?? undefined}>
            <Input
              id="pw-new"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </Field>
        </div>
      </Dialog>
    </>
  );
}
