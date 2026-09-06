"use client";

import { type CSSProperties, useState } from "react";
import { Button, Checkbox, Field, Icon, Input, Select } from "@/components/ds";

const styles: Record<string, CSSProperties> = {
  root: {
    flex: 1,
    minHeight: "100%",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "40px 24px",
    background: "var(--surface-sunken)",
  },
  col: { width: "min(460px, 100%)", display: "flex", flexDirection: "column", gap: 20 },
  progress: { display: "flex", gap: 6 },
  seg: { flex: 1, height: 4, borderRadius: "var(--radius-full)", background: "var(--grey-200)" },
  segOn: { background: "var(--terracotta-500)" },
  step: {
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: "var(--tracking-caps)",
    textTransform: "uppercase",
    color: "var(--text-subtle)",
  },
  heading: { margin: 0, fontSize: 24, fontWeight: 600, letterSpacing: "var(--tracking-tight)", color: "var(--text-strong)" },
  sub: { fontSize: 14, color: "var(--text-muted)", marginTop: 6 },
  card: {
    background: "var(--surface-canvas)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-lg)",
    boxShadow: "var(--shadow-dialog)",
    padding: 24,
    display: "flex",
    flexDirection: "column",
    gap: 16,
  },
  nav: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  error: {
    fontSize: 13,
    color: "var(--text-danger, var(--terracotta-700))",
    background: "var(--surface-danger-soft, rgba(198,93,69,0.08))",
    border: "1px solid var(--terracotta-300, rgba(198,93,69,0.3))",
    borderRadius: "var(--radius-md)",
    padding: "8px 12px",
  },
};

const TOTAL = 3;

const ROLES = ["Gérant·e", "Comptable", "Chef·fe d'atelier", "Menuisier·ère", "Autre"];
const SIZES = ["1 à 5 personnes", "6 à 20 personnes", "21 à 50 personnes", "Plus de 50 personnes"];

export function OnboardingFlow({
  firstName,
  onFinish,
  pending = false,
  error,
}: {
  firstName?: string;
  /** Create the space. The caller drives the request and the move into the app. */
  onFinish: (data: { workspaceName: string }) => void;
  /** True while the space is being created, to disable the final action. */
  pending?: boolean;
  /** Error to surface on the last step when the creation was refused. */
  error?: string | null;
}) {
  const [step, setStep] = useState(0);
  const [workspace, setWorkspace] = useState("");
  const [invites, setInvites] = useState(["", "", ""]);

  const name = workspace.trim() || "Mon espace";
  const next = () => setStep((s) => Math.min(s + 1, TOTAL));
  const back = () => setStep((s) => Math.max(s - 1, 0));
  const setInvite = (i: number, v: string) => setInvites((prev) => prev.map((e, idx) => (idx === i ? v : e)));

  // Final "done" screen.
  if (step === TOTAL) {
    const invited = invites.filter((e) => e.includes("@")).length;
    return (
      <div style={styles.root}>
        <div style={styles.col} role="main">
          <div style={{ ...styles.card, alignItems: "center", textAlign: "center", gap: 12 }}>
            <span
              style={{
                width: 52,
                height: 52,
                borderRadius: "var(--radius-full)",
                background: "var(--status-success-bg)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Icon name="check" size={26} style={{ color: "var(--status-success-fg)" }} />
            </span>
            <h1 style={styles.heading}>Tout est prêt{firstName ? `, ${firstName}` : ""}</h1>
            <p style={{ fontSize: 14, color: "var(--text-muted)", maxWidth: 340 }}>
              L&apos;espace <strong>{name}</strong> va être créé{invited > 0 ? `, avec ${invited} invitation${invited > 1 ? "s" : ""}` : ""}. Vous pourrez importer vos
              historiques Slack, Mattermost ou Nextcloud à tout moment depuis la barre latérale.
            </p>
            {error ? (
              <p style={styles.error} role="alert">
                {error}
              </p>
            ) : null}
            <Button
              variant="primary"
              size="lg"
              fullWidth
              disabled={pending}
              onClick={() => onFinish({ workspaceName: name })}
            >
              {pending ? "Création…" : "Entrer dans Ruchoir"}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.root}>
      <div style={styles.col} role="main">
        <div style={styles.progress}>
          {Array.from({ length: TOTAL }).map((_, i) => (
            <span key={i} style={{ ...styles.seg, ...(i <= step ? styles.segOn : {}) }} />
          ))}
        </div>
        <div>
          <div style={styles.step}>Étape {step + 1} sur {TOTAL}</div>
          <h1 style={{ ...styles.heading, marginTop: 8 }}>
            {step === 0 ? "Comment s'appelle votre espace ?" : step === 1 ? "Parlez-nous de vous" : "Invitez votre équipe"}
          </h1>
          <p style={styles.sub}>
            {step === 0
              ? "Ce sera le nom affiché de votre espace de travail. Vous pourrez le changer plus tard."
              : step === 1
                ? "Ces informations nous aident à préparer votre espace. Rien n'est obligatoire."
                : "Ajoutez quelques adresses pour démarrer à plusieurs. Vous pourrez inviter d'autres personnes ensuite."}
          </p>
        </div>

        <div style={styles.card}>
          {step === 0 ? (
            <>
              <Field label="Nom de l'espace" htmlFor="ob-ws">
                <Input
                  id="ob-ws"
                  size="lg"
                  autoFocus
                  placeholder="ex. Atelier Nantes"
                  value={workspace}
                  onChange={(e) => setWorkspace(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") next();
                  }}
                />
              </Field>
              <Checkbox defaultChecked label="Autoriser toute personne de mon domaine à rejoindre cet espace" />
            </>
          ) : null}

          {step === 1 ? (
            <>
              <Field label="Votre rôle" htmlFor="ob-role">
                <Select id="ob-role" size="lg" options={ROLES} />
              </Field>
              <Field label="Taille de l'équipe" htmlFor="ob-size">
                <Select id="ob-size" size="lg" options={SIZES} />
              </Field>
            </>
          ) : null}

          {step === 2 ? (
            <>
              {invites.map((email, i) => (
                <Input
                  key={i}
                  size="lg"
                  icon="mail"
                  type="email"
                  placeholder="prenom@exemple.fr"
                  value={email}
                  onChange={(e) => setInvite(i, e.target.value)}
                />
              ))}
              <Checkbox defaultChecked label="Autoriser toute personne de mon domaine à rejoindre" />
            </>
          ) : null}
        </div>

        <div style={styles.nav}>
          {step > 0 ? (
            <Button iconLeft="arrow-left" onClick={back}>
              Retour
            </Button>
          ) : (
            <span />
          )}
          <div style={{ display: "flex", gap: 8 }}>
            {step === 2 ? (
              <Button variant="ghost" onClick={next}>
                Passer
              </Button>
            ) : null}
            <Button variant="primary" onClick={next}>
              {step === 2 ? "Terminer" : "Continuer"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
