"use client";

import { type CSSProperties, useState } from "react";
import { Avatar, Button, Dialog, Field, Icon, Input, Radio, Select } from "@/components/ds";
import type { Presence } from "@/components/ds";
import type { ChannelType, Invitation } from "@/lib/data";
import { COMMANDS, formatChord, isMac } from "./shortcuts";
import { useSettings } from "./settings";
import { getAvatar } from "@/lib/data";

const listItem: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  width: "100%",
  padding: "8px 10px",
  border: 0,
  borderRadius: "var(--radius-md)",
  background: "transparent",
  cursor: "pointer",
  textAlign: "left",
};

/** Create a new channel: name, visibility, optional topic. */
export function NewChannelDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (channel: { name: string; type: ChannelType; topic: string }) => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<ChannelType>("public");
  const [topic, setTopic] = useState("");

  const submit = () => {
    const clean = name.trim().replace(/^#/, "");
    if (!clean) return;
    onCreate({ name: clean, type, topic: topic.trim() });
  };

  return (
    <Dialog
      title="Nouveau canal"
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Annuler</Button>
          <Button variant="primary" onClick={submit}>
            Créer le canal
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <Field label="Nom du canal" htmlFor="ch-name">
          <Input
            id="ch-name"
            autoFocus
            icon="hash"
            placeholder="ex. lancement-produit"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
        </Field>
        <Field label="Visibilité">
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <Radio
              name="ch-type"
              checked={type === "public"}
              onChange={() => setType("public")}
              label="Public"
              description="Tous les membres de l'espace peuvent le rejoindre."
            />
            <Radio
              name="ch-type"
              checked={type === "private"}
              onChange={() => setType("private")}
              label="Privé"
              description="Sur invitation uniquement."
            />
          </div>
        </Field>
        <Field label="Sujet" optional htmlFor="ch-topic">
          <Input id="ch-topic" placeholder="À quoi sert ce canal ?" value={topic} onChange={(e) => setTopic(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

/** Pick a person to start (or open) a direct message with. */
export function NewMessageDialog({
  people,
  onClose,
  onSelect,
}: {
  people: { name: string; presence: Presence; bot?: boolean }[];
  onClose: () => void;
  onSelect: (name: string) => void;
}) {
  const [q, setQ] = useState("");
  const rows = people.filter((p) => p.name.toLowerCase().includes(q.toLowerCase()));

  return (
    <Dialog title="Nouveau message" size="sm" onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Input autoFocus icon="search" placeholder="À qui souhaitez-vous écrire ?" value={q} onChange={(e) => setQ(e.target.value)} />
        <div style={{ display: "flex", flexDirection: "column", gap: 2, maxHeight: 280, overflow: "auto" }}>
          {rows.map((p) => (
            <button
              key={p.name}
              type="button"
              style={listItem}
              className="wc-listrow"
              onClick={() => onSelect(p.name)}
            >
              <Avatar name={p.name} src={getAvatar(p.name)} size={26} presence={p.presence} kind={p.bot ? "bot" : "person"} />
              <span style={{ fontSize: 13, color: "var(--text-strong)" }}>{p.name}</span>
            </button>
          ))}
          {rows.length === 0 ? (
            <p style={{ fontSize: 13, color: "var(--text-muted)", padding: "8px 10px" }}>Personne ne correspond.</p>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}

/** Role labels, in the order an administrator is likely to want them. Values are the API's. */
const INVITE_ROLES = [
  { value: "member", label: "Membre" },
  { value: "admin", label: "Administrateur" },
  { value: "guest", label: "Invité externe" },
];

const inviteStyles: Record<string, CSSProperties> = {
  body: { display: "flex", flexDirection: "column", gap: 16 },
  section: { display: "flex", flexDirection: "column", gap: 8 },
  sectionTitle: { fontSize: 12, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase" },
  link: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 10px",
    background: "var(--surface-sunken)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-md)",
  },
  linkText: {
    flex: 1,
    minWidth: 0,
    fontFamily: "var(--font-mono)",
    fontSize: 12,
    color: "var(--text-default)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "8px 0",
    borderTop: "1px solid var(--border-subtle)",
    fontSize: 13,
  },
  rowMain: { flex: 1, minWidth: 0 },
  rowMeta: { fontSize: 12, color: "var(--text-muted)" },
  empty: { fontSize: 13, color: "var(--text-muted)" },
};

export type InviteDialogProps = {
  onClose: () => void;
  /**
   * Whether the caller may administer this space. The API is the real guard; this only avoids
   * offering a form whose every submission would be refused.
   */
  canInvite: boolean;
  /** Issue an invitation. Resolves to the one-time link, and whether the email actually went out. */
  onCreate: (options: { email?: string; role: string }) => Promise<{ url: string; emailed: boolean }>;
  /** The outstanding invitations, already loaded by the caller. */
  invitations: Invitation[];
  /** Stop accepting one. The caller refreshes the list. */
  onRevoke: (id: string) => Promise<void>;
};

/**
 * Invite people into the space: by address, or with a shareable link.
 *
 * The created link is shown once and only once, because the API stores only its digest and cannot
 * hand it back. That is why the field stays on screen with a copy button until the dialog is
 * closed, and why revoking and re-issuing is one click rather than a recovery flow.
 */
export function InviteDialog({ onClose, canInvite, onCreate, invitations, onRevoke }: InviteDialogProps) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ url: string; emailed: boolean } | null>(null);
  const [copied, setCopied] = useState(false);

  const address = email.trim();
  const addressed = address.length > 0;

  const submit = async () => {
    if (pending) return;
    if (addressed && !address.includes("@")) {
      setError("Cette adresse ne semble pas valide.");
      return;
    }
    setPending(true);
    setError(null);
    setCopied(false);
    try {
      setCreated(await onCreate({ email: addressed ? address : undefined, role }));
      setEmail("");
    } catch {
      setError("L'invitation n'a pas pu être créée. Réessayez.");
    } finally {
      setPending(false);
    }
  };

  const copy = () => {
    if (!created) return;
    void navigator.clipboard?.writeText(created.url).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };

  return (
    <Dialog
      title="Inviter des personnes"
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Fermer</Button>
          {canInvite ? (
            <Button
              variant="primary"
              iconLeft={addressed ? "send" : "external-link"}
              disabled={pending}
              onClick={() => void submit()}
            >
              {addressed ? "Envoyer l'invitation" : "Créer un lien"}
            </Button>
          ) : null}
        </>
      }
    >
      {!canInvite ? (
        <p style={inviteStyles.empty}>
          Seuls les propriétaires et les administrateurs de l&apos;espace peuvent inviter des personnes. Demandez à
          l&apos;un d&apos;eux de vous envoyer une invitation.
        </p>
      ) : (
      <div style={inviteStyles.body}>
        <Field
          label="Adresse électronique"
          hint="Laissez vide pour créer un lien partageable au lieu d'un envoi par courriel."
          htmlFor="inv"
        >
          <Input
            id="inv"
            autoFocus
            icon="mail"
            placeholder="prenom@exemple.fr"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Rôle à l'arrivée" htmlFor="inv-role">
          <Select
            id="inv-role"
            options={INVITE_ROLES}
            value={role}
            onChange={(e) => setRole(e.target.value)}
          />
        </Field>

        {error ? (
          <p role="alert" style={{ ...inviteStyles.empty, color: "var(--text-danger, var(--terracotta-700))" }}>
            {error}
          </p>
        ) : null}

        {created ? (
          <div style={inviteStyles.section}>
            <div style={inviteStyles.sectionTitle}>
              {created.emailed ? "Invitation envoyée" : "Lien d'invitation"}
            </div>
            <p style={inviteStyles.empty}>
              {created.emailed
                ? "Le courriel est parti. Ce lien ne sera plus affiché, copiez-le si vous voulez le transmettre autrement."
                : "Copiez ce lien maintenant : il ne pourra plus être affiché."}
            </p>
            <div style={inviteStyles.link}>
              <span style={inviteStyles.linkText}>{created.url}</span>
              <Button size="sm" iconLeft={copied ? "check" : "copy"} onClick={copy}>
                {copied ? "Copié" : "Copier"}
              </Button>
            </div>
          </div>
        ) : null}

        <div style={inviteStyles.section}>
          <div style={inviteStyles.sectionTitle}>Invitations en cours</div>
          {invitations.length === 0 ? (
            <p style={inviteStyles.empty}>Aucune invitation en attente.</p>
          ) : (
            invitations.map((invitation) => (
              <div key={invitation.id} style={inviteStyles.row}>
                <div style={inviteStyles.rowMain}>
                  <div>{invitation.email ?? "Lien partageable"}</div>
                  <div style={inviteStyles.rowMeta}>
                    {INVITE_ROLES.find((r) => r.value === invitation.role)?.label ?? invitation.role}
                    {" · "}
                    {invitation.maxUses === undefined
                      ? `${invitation.uses} utilisation${invitation.uses > 1 ? "s" : ""}`
                      : `${invitation.uses}/${invitation.maxUses}`}
                    {invitation.usable ? "" : " · inactive"}
                  </div>
                </div>
                <Button size="sm" iconLeft="x" onClick={() => void onRevoke(invitation.id)}>
                  Révoquer
                </Button>
              </div>
            ))
          )}
        </div>
      </div>
      )}
    </Dialog>
  );
}

/** Create a new workspace. */
export function NewWorkspaceDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string) => void }) {
  const [name, setName] = useState("");
  const submit = () => {
    const clean = name.trim();
    if (!clean) return;
    onCreate(clean);
  };

  return (
    <Dialog
      title="Nouvel espace de travail"
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Annuler</Button>
          <Button variant="primary" onClick={submit}>
            Créer l&apos;espace
          </Button>
        </>
      }
    >
      <Field label="Nom de l'espace" hint="Vous pourrez inviter des membres juste après." htmlFor="ws-name">
        <Input
          id="ws-name"
          autoFocus
          placeholder="ex. Studio Loire"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
      </Field>
    </Dialog>
  );
}

const HELP_LINKS: [string, string][] = [
  ["Guide de prise en main", "book-open"],
  ["Importer depuis Slack, Mattermost, Nextcloud", "import"],
  ["Raccourcis clavier et astuces", "key-round"],
  ["Contacter le support", "life-buoy"],
];

/** Help centre: documentation links and the live (customizable) keyboard shortcuts. */
export function HelpDialog({
  onClose,
  onCustomize,
  onGettingStarted,
}: {
  onClose: () => void;
  onCustomize?: () => void;
  onGettingStarted?: () => void;
}) {
  const { shortcuts } = useSettings();
  const mac = isMac();
  return (
    <Dialog title="Aide" subtitle="Documentation et raccourcis" size="md" onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 18 }}>
        {HELP_LINKS.map(([label, icon]) => {
          // The first link reopens the in-app getting-started checklist; the rest are placeholder docs.
          const isGettingStarted = icon === "book-open" && !!onGettingStarted;
          return (
            <a
              key={label}
              href="#"
              onClick={(e) => {
                e.preventDefault();
                if (isGettingStarted) onGettingStarted!();
              }}
              style={{ ...listItem, textDecoration: "none", color: "var(--text-strong)" }}
              className="wc-listrow"
            >
              <Icon name={icon === "book-open" ? "file-text" : icon} size={16} style={{ color: "var(--text-muted)" }} />
              <span style={{ flex: 1, fontSize: 13 }}>{label}</span>
              <Icon name={isGettingStarted ? "chevron-right" : "external-link"} size={13} style={{ color: "var(--text-subtle)" }} />
            </a>
          );
        })}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          margin: "0 0 8px",
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "var(--tracking-caps)",
            textTransform: "uppercase",
            color: "var(--text-subtle)",
          }}
        >
          Raccourcis clavier
        </span>
        {onCustomize ? (
          <Button size="sm" variant="link" onClick={onCustomize}>
            Personnaliser
          </Button>
        ) : null}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {COMMANDS.map((c) => {
          const keys = formatChord(shortcuts[c.id], mac);
          return (
            <div key={c.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "6px 2px" }}>
              <span style={{ fontSize: 13, color: "var(--text-body)" }}>{c.label}</span>
              {keys ? (
                <kbd
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 12,
                    color: "var(--text-muted)",
                    background: "var(--grey-100)",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: "var(--radius-sm)",
                    padding: "1px 6px",
                    whiteSpace: "nowrap",
                  }}
                >
                  {keys}
                </kbd>
              ) : (
                <span style={{ fontSize: 12, color: "var(--text-subtle)" }}>Non attribué</span>
              )}
            </div>
          );
        })}
      </div>
    </Dialog>
  );
}
