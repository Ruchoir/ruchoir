"use client";

import { type CSSProperties, type ReactNode, useRef, useState } from "react";
import { Avatar, Button, Card, Checkbox, Dialog, Field, Icon, IconButton, Input, Select, Switch, Tag } from "@/components/ds";
import type { Presence } from "@/components/ds";
import type { Toast } from "../app/types";
import { clearSpaceIcon, setSpaceIcon } from "@/lib/data/api";
import { ImageCropDialog } from "../app/ImageCropDialog";

type NavKey = "general" | "members" | "notifs" | "imports" | "storage" | "security";

const NAV: [NavKey, string, string][] = [
  ["general", "Général", "settings"],
  ["members", "Membres", "users"],
  ["notifs", "Notifications", "bell"],
  ["imports", "Imports", "import"],
  ["storage", "Stockage", "hard-drive"],
  ["security", "Sécurité", "shield"],
];

const st: Record<string, CSSProperties> = {
  top: {
    height: "var(--topbar-height)",
    flex: "none",
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "0 16px",
    margin: 0, // rendered as an <h1>
    borderBottom: "1px solid var(--border-subtle)",
    fontSize: 15,
    fontWeight: 600,
    letterSpacing: "var(--tracking-tight)",
    color: "var(--text-strong)",
  },
  body: { flex: 1, overflow: "auto", display: "flex", minWidth: 0, minHeight: 0 },
  nav: { width: 200, flex: "none", padding: "16px 8px", borderRight: "1px solid var(--border-subtle)" },
  main: { flex: 1, minWidth: 0, padding: "24px 28px", maxWidth: 760 },
  h: { fontSize: 18, marginBottom: 4 },
  sub: { fontSize: 13, color: "var(--text-muted)", marginBottom: 20 },
  sect: {
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: "var(--tracking-caps)",
    textTransform: "uppercase",
    color: "var(--text-subtle)",
    margin: "24px 0 10px",
  },
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 12,
    rowGap: 8,
    padding: "12px 0",
    borderBottom: "1px solid var(--border-subtle)",
  },
  rowT: { fontSize: 13, fontWeight: 500, color: "var(--text-strong)" },
  rowD: { fontSize: 12, color: "var(--text-muted)", marginTop: 2, maxWidth: 420 },
};

function navItem(on: boolean, compact = false): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: compact ? "auto" : "100%",
    flex: "none",
    height: 30,
    padding: "0 10px",
    border: 0,
    borderRadius: "var(--radius-sm)",
    background: on ? "var(--surface-selected)" : compact ? "var(--surface-sunken)" : "transparent",
    color: on ? "var(--text-accent)" : "var(--text-body)",
    fontFamily: "var(--font-sans)",
    fontSize: 13,
    fontWeight: on ? 500 : 400,
    cursor: "pointer",
    textAlign: "left",
    whiteSpace: "nowrap",
  };
}

/** A title + description on the left, a control on the right, matching the mockup rows. */
function SettingRow({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <div style={st.row}>
      <span>
        <div style={st.rowT}>{title}</div>
        {desc ? <div style={st.rowD}>{desc}</div> : null}
      </span>
      {children}
    </div>
  );
}

const ROLE_BY_NAME: Record<string, string> = {
  "Camille Roussel": "Administrateur",
  "Adèle Fournier": "Modérateur",
  "Sofia Nadir": "Invité externe",
};

export type WorkspaceSettingsProps = {
  workspaceName: string;
  /** The space being configured; needed to address its icon. */
  spaceId: string;
  /** Its current icon, when one was uploaded. */
  iconUrl?: string;
  /** Whether the caller may change the icon. The API is the real guard; this hides a dead control. */
  canAdminister: boolean;
  members: { name: string; presence: Presence }[];
  onInvite: () => void;
  /**
   * The icon changed. The rail reads the space list, not this screen's state, so without this the
   * new icon only appears after a reload.
   */
  onIconChanged: (url?: string) => void;
  onNotify: (toast: Toast) => void;
  /** Compact (mobile): stack the sub-nav above the panel and let setting rows wrap. */
  compact?: boolean;
};

/** The workspace settings view. Faithful to the design-system `screen-settings` mockup. */
export function WorkspaceSettings({
  workspaceName,
  spaceId,
  iconUrl,
  canAdminister,
  members,
  onInvite,
  onIconChanged,
  onNotify,
  compact = false,
}: WorkspaceSettingsProps) {
  const [tab, setTab] = useState<NavKey>("general");
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** A local change since the space was loaded: a URL just uploaded, `null` just removed. */
  const [iconOverride, setIconOverride] = useState<string | null | undefined>(undefined);
  const [iconBusy, setIconBusy] = useState(false);
  /** The picked file, held until it has been cropped. */
  const [cropping, setCropping] = useState<File | null>(null);
  const icon = iconOverride === null ? undefined : (iconOverride ?? iconUrl);
  const iconRef = useRef<HTMLInputElement>(null);

  const onIconPicked = (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (!file) return;
    if (iconRef.current) iconRef.current.value = "";
    // Same reason as the avatar: the rail shows a square, so the square is chosen.
    setCropping(file);
  };

  const uploadCropped = async (file: File) => {
    setCropping(null);
    setIconBusy(true);
    try {
      const url = await setSpaceIcon(spaceId, file);
      setIconOverride(url);
      onIconChanged(url);
      onNotify({ tone: "success", title: "Icône mise à jour", description: workspaceName });
    } catch {
      onNotify({ tone: "danger", title: "Icône non enregistrée", description: "Choisissez une image plus légère." });
    } finally {
      setIconBusy(false);
    }
  };

  const removeIcon = async () => {
    setIconBusy(true);
    try {
      await clearSpaceIcon(spaceId);
      setIconOverride(null);
      onIconChanged(undefined);
    } catch {
      onNotify({ tone: "danger", title: "Icône non retirée" });
    } finally {
      setIconBusy(false);
    }
  };

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
      <h1 style={st.top}>
        <Icon name="settings" size={15} style={{ color: "var(--text-muted)" }} />
        Réglages de l&apos;espace
      </h1>
      <div style={compact ? { ...st.body, flexDirection: "column" } : st.body}>
        <div
          style={
            compact
              ? {
                  flex: "none",
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 6,
                  padding: "8px 12px",
                  borderBottom: "1px solid var(--border-subtle)",
                }
              : st.nav
          }
        >
          {NAV.map(([v, l, i]) => (
            <button key={v} style={navItem(v === tab, compact)} onClick={() => setTab(v)}>
              <Icon name={i} size={14} style={{ color: "var(--text-muted)" }} />
              {l}
            </button>
          ))}
        </div>
        <div style={compact ? { ...st.main, padding: "16px 16px 24px" } : st.main}>
          {tab === "general" ? (
            <>
              <h2 style={st.h}>Général</h2>
              <p style={st.sub}>Identité et langue de l&apos;espace {workspaceName}.</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 420 }}>
                <Field label="Icône de l'espace">
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <Avatar name={workspaceName} src={icon} kind="workspace" size={48} />
                    {canAdminister ? (
                      <>
                        <Button
                          size="sm"
                          variant="secondary"
                          iconLeft="image"
                          disabled={iconBusy}
                          onClick={() => iconRef.current?.click()}
                        >
                          {iconBusy ? "Envoi…" : "Changer l'icône"}
                        </Button>
                        {icon ? (
                          <Button size="sm" variant="link" disabled={iconBusy} onClick={() => void removeIcon()}>
                            Retirer
                          </Button>
                        ) : null}
                      </>
                    ) : (
                      <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
                        Seuls les administrateurs de l&apos;espace peuvent la changer.
                      </span>
                    )}
                    <input
                      ref={iconRef}
                      type="file"
                      accept="image/*"
                      style={{ display: "none" }}
                      onChange={(e) => onIconPicked(e.target.files)}
                    />
                  </div>
                </Field>
                <Field label="Nom de l'espace" htmlFor="wn">
                  <Input id="wn" defaultValue={workspaceName} />
                </Field>
                <Field label="Adresse du serveur" hint="Modifiable par un administrateur système uniquement" htmlFor="wu">
                  <Input id="wu" defaultValue="atelier.ruchoir.fr" disabled />
                </Field>
                <Field label="Langue par défaut" htmlFor="wl">
                  <Select id="wl" options={["Français", "English", "Deutsch", "Español"]} />
                </Field>
                <Field label="Fuseau horaire" htmlFor="wt">
                  <Select id="wt" options={["Europe/Paris", "Europe/Bruxelles", "Atlantique/Reykjavik"]} />
                </Field>
              </div>
              <div style={st.sect}>Comportement</div>
              <SettingRow title="Créer des canaux librement" desc="Tous les membres peuvent créer des canaux publics.">
                <Switch defaultChecked />
              </SettingRow>
              <SettingRow title="Archiver les canaux inactifs" desc="Après 180 jours sans message, le canal passe en archive.">
                <Switch defaultChecked />
              </SettingRow>
              <SettingRow title="Rendre l'espace découvrable" desc="Les personnes de votre domaine peuvent demander à rejoindre.">
                <Switch />
              </SettingRow>
            </>
          ) : null}

          {tab === "members" ? (
            <>
              <h2 style={st.h}>Membres</h2>
              <p style={st.sub}>
                {members.length} membres, 2 invités externes, 1 bot.
              </p>
              <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                <div style={{ width: 260 }}>
                  <Input size="sm" icon="search" placeholder="Rechercher un membre" />
                </div>
                <div style={{ flex: 1 }} />
                <Button size="sm" variant="primary" iconLeft="user-plus" onClick={onInvite}>
                  Inviter
                </Button>
              </div>
              <Card>
                {members.map((m, i) => {
                  const role = ROLE_BY_NAME[m.name] ?? "Membre";
                  const guest = role.startsWith("Invité");
                  const email = `${m.name.split(" ")[0].toLowerCase()}@atelier-nantes.fr`;
                  return (
                    <div
                      key={m.name}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        padding: "10px 14px",
                        borderTop: i ? "1px solid var(--border-subtle)" : "none",
                      }}
                    >
                      <Avatar name={m.name} size={28} presence={m.presence} shape={guest ? "round" : "square"} />
                      <span style={{ flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-strong)" }}>{m.name}</div>
                        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{email}</div>
                      </span>
                      {guest ? <Tag tone="warning">Externe</Tag> : null}
                      <div style={{ width: 170 }}>
                        <Select
                          size="sm"
                          options={["Membre", "Modérateur", "Administrateur", "Invité externe"]}
                          defaultValue={role}
                          onChange={() => onNotify({ tone: "success", title: "Rôle mis à jour", description: m.name })}
                        />
                      </div>
                      <IconButton
                        icon="more-horizontal"
                        label={`Actions pour ${m.name}`}
                        size="sm"
                        onClick={() => onNotify({ tone: "info", title: m.name, description: `${role} · ${email}` })}
                      />
                    </div>
                  );
                })}
              </Card>
            </>
          ) : null}

          {tab === "notifs" ? (
            <>
              <h2 style={st.h}>Notifications</h2>
              <p style={st.sub}>Réglages appliqués à votre compte sur cet espace.</p>
              <div style={st.sect}>Bureau</div>
              <SettingRow title="Notifications sur le bureau" desc="Mentions directes et messages privés.">
                <Switch defaultChecked />
              </SettingRow>
              <SettingRow title="Aperçu du message" desc="Afficher le début du message dans la notification.">
                <Switch />
              </SettingRow>
              <SettingRow title="Son à la réception">
                <Switch defaultChecked />
              </SettingRow>
              <div style={st.sect}>Heures calmes</div>
              <div style={{ display: "flex", gap: 12, alignItems: "flex-end", maxWidth: 420 }}>
                <Field label="De" htmlFor="q1">
                  <Input id="q1" defaultValue="19:00" />
                </Field>
                <Field label="À" htmlFor="q2">
                  <Input id="q2" defaultValue="08:30" />
                </Field>
                <Field label="Jours" htmlFor="q3">
                  <Select id="q3" options={["Tous les jours", "Jours ouvrés", "Week-end"]} />
                </Field>
              </div>
            </>
          ) : null}

          {tab === "imports" ? (
            <>
              <h2 style={st.h}>Imports</h2>
              <p style={st.sub}>Historique des migrations vers cet espace.</p>
              <Card>
                {(
                  [
                    ["Slack", "Terminé", "14 janv. 2026", "8 912 messages · 143 fichiers", "success", "check"],
                    ["Mattermost", "Terminé", "3 févr. 2026", "2 104 messages · 38 fichiers", "success", "check"],
                    ["Nextcloud", "En cours", "Aujourd'hui, 08:12", "4,7 Go sur 11 Go", "warning", "clock"],
                  ] as const
                ).map(([n, s, d, det, tone, icon], i) => (
                  <div
                    key={n}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "12px 14px",
                      borderTop: i ? "1px solid var(--border-subtle)" : "none",
                    }}
                  >
                    <Icon name="import" size={18} style={{ color: "var(--text-muted)" }} />
                    <span style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-strong)" }}>{n}</div>
                      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{det}</div>
                    </span>
                    <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{d}</span>
                    <Tag tone={tone} icon={icon}>
                      {s}
                    </Tag>
                  </div>
                ))}
              </Card>
              <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 12 }}>
                Un import terminé peut être annulé pendant 30 jours ; les contenus repris sont alors supprimés.
              </p>
            </>
          ) : null}

          {tab === "storage" ? (
            <>
              <h2 style={st.h}>Stockage</h2>
              <p style={st.sub}>11,4 Go utilisés sur 200 Go.</p>
              <div style={{ height: 8, borderRadius: 999, background: "var(--grey-100)", overflow: "hidden", maxWidth: 520, display: "flex" }}>
                <div style={{ width: "42%", background: "var(--terracotta-500)" }} />
                <div style={{ width: "14%", background: "var(--terracotta-200)" }} />
              </div>
              <div style={{ display: "flex", gap: 18, marginTop: 10, fontSize: 12, color: "var(--text-muted)" }}>
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--terracotta-500)" }} />
                  Fichiers 8,1 Go
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--terracotta-200)" }} />
                  Historique importé 3,3 Go
                </span>
              </div>
              <div style={st.sect}>Rétention</div>
              <div style={{ maxWidth: 420, display: "flex", flexDirection: "column", gap: 14 }}>
                <Field label="Conserver les messages" htmlFor="r1">
                  <Select id="r1" options={["Indéfiniment", "5 ans", "3 ans", "1 an"]} />
                </Field>
                <Checkbox label="Supprimer les fichiers des canaux archivés" description="90 jours après l'archivage" />
              </div>
            </>
          ) : null}

          {tab === "security" ? (
            <>
              <h2 style={st.h}>Sécurité</h2>
              <p style={st.sub}>Accès, sessions et journalisation.</p>
              <SettingRow title="Authentification à deux facteurs obligatoire" desc="Pour tous les membres, hors invités externes.">
                <Switch defaultChecked />
              </SettingRow>
              <SettingRow title="Authentification unique (SSO)" desc="Connecté à Keycloak sur auth.atelier-nantes.fr.">
                <Switch defaultChecked />
              </SettingRow>
              <SettingRow title="Chiffrement des fichiers au repos" desc="AES-256 côté serveur.">
                <Switch defaultChecked />
              </SettingRow>
              <SettingRow title="Journal d'audit exportable" desc="Format CSV, 12 mois glissants.">
                <Switch />
              </SettingRow>
              <div
                style={{
                  marginTop: 24,
                  padding: 14,
                  border: "1px solid var(--status-danger-border)",
                  background: "var(--status-danger-bg)",
                  borderRadius: "var(--radius-md)",
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                }}
              >
                <span style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: "var(--status-danger-fg)" }}>Supprimer l&apos;espace</div>
                  <div style={{ fontSize: 12, color: "var(--status-danger-fg)", opacity: 0.85 }}>
                    Les 8 912 messages et 143 fichiers seront effacés après 30 jours.
                  </div>
                </span>
                <Button variant="danger" iconLeft="trash-2" onClick={() => setConfirmDelete(true)}>
                  Supprimer
                </Button>
              </div>
            </>
          ) : null}
        </div>
      </div>

      <Dialog
        open={confirmDelete}
        title="Supprimer l'espace ?"
        size="sm"
        onClose={() => setConfirmDelete(false)}
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>Annuler</Button>
            <Button
              variant="danger"
              iconLeft="trash-2"
              onClick={() => {
                setConfirmDelete(false);
                onNotify({ tone: "warning", title: "Suppression programmée", description: `L'espace ${workspaceName} sera effacé dans 30 jours.` });
              }}
            >
              Supprimer l&apos;espace
            </Button>
          </>
        }
      >
        <p style={{ fontSize: 13, color: "var(--text-body)" }}>
          Cette action programme l&apos;effacement de {workspaceName} et de tous ses contenus après un délai de 30 jours.
          Vous pouvez l&apos;annuler pendant ce délai.
        </p>
      </Dialog>

      {cropping ? (
        <ImageCropDialog
          file={cropping}
          title="Cadrer l'icône"
          onCancel={() => setCropping(null)}
          onConfirm={(cropped) => void uploadCropped(cropped)}
        />
      ) : null}
    </div>
  );
}
