"use client";

import { type CSSProperties, useState } from "react";
import { Avatar, Button, Dialog, Field, Icon, Input, Radio, Select } from "@/components/ds";
import type { Presence } from "@/components/ds";
import type { ChannelType, Invitation } from "@/lib/data";
import { COMMANDS, formatChord, isMac } from "./shortcuts";
import { useSettings } from "./settings";
import { getAvatar } from "@/lib/data";
import { useTranslation } from "@/lib/i18n";

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
  const { t } = useTranslation();
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
      title={t("sidebar.newChannel")}
      closeLabel={t("common.close")}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={submit}>
            Créer le canal
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <Field label={t("channel.name")} htmlFor="ch-name">
          <Input
            id="ch-name"
            autoFocus
            icon="hash"
            placeholder={t("dialogs.channelPlaceholder")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
        </Field>
        <Field label={t("channel.visibility")}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <Radio
              name="ch-type"
              checked={type === "public"}
              onChange={() => setType("public")}
              label={t("channel.public")}
              description={t("channel.publicHint")}
            />
            <Radio
              name="ch-type"
              checked={type === "private"}
              onChange={() => setType("private")}
              label={t("channel.private")}
              description={t("dialogs.privateHint")}
            />
          </div>
        </Field>
        <Field label={t("channel.topic")} optional htmlFor="ch-topic">
          <Input id="ch-topic" placeholder={t("channel.topicPlaceholder")} value={topic} onChange={(e) => setTopic(e.target.value)} />
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
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const rows = people.filter((p) => p.name.toLowerCase().includes(q.toLowerCase()));

  return (
    <Dialog title={t("shell.newMessage")}
      closeLabel={t("common.close")} size="sm" onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Input autoFocus icon="search" placeholder={t("dialogs.writeTo")} value={q} onChange={(e) => setQ(e.target.value)} />
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
            <p style={{ fontSize: 13, color: "var(--text-muted)", padding: "8px 10px" }}>{t("dialogs.nobodyMatches")}</p>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}

/**
 * Roles, in the order an administrator is likely to want them. Values are the API's, labels are
 * dictionary keys: the list is built at module load, where no language is in force yet.
 */
const INVITE_ROLES = [
  { value: "member", labelKey: "role.member" },
  { value: "admin", labelKey: "admin.adminTag" },
  { value: "guest", labelKey: "dialogs.guest" },
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
  notice: {
    fontSize: 12,
    lineHeight: 1.5,
    color: "var(--text-muted)",
    padding: "8px 10px",
    background: "var(--surface-sunken)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-md)",
  },
};

/**
 * What an invitation's state is called, in the order it reads best: role, uses, outcome.
 *
 * Takes the translator: the plural of "use" is the dictionary's business, and so is the role.
 */
function describeInvitation(invitation: Invitation, t: (key: string, options?: Record<string, unknown>) => string): string {
  const found = INVITE_ROLES.find((r) => r.value === invitation.role);
  const role = found ? t(found.labelKey) : invitation.role;
  const uses =
    invitation.maxUses === undefined
      ? t("dialogs.uses", { count: invitation.uses })
      : `${invitation.uses}/${invitation.maxUses}`;
  const outcome = {
    active: "",
    accepted: "dialogs.accepted",
    revoked: "dialogs.revoked",
    expired: "dialogs.expired",
  }[invitation.status];
  return `${role} · ${uses}${outcome ? ` ${t(outcome)}` : ""}`;
}

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
  /**
   * Whether this instance can send email. When it cannot, an addressed invitation still works (the
   * link has to be handed over by other means) but a shareable link leads to an account waiting on
   * a confirmation message that is never sent, so the dialog says so.
   */
  emailDelivery?: boolean;
};

/**
 * Invite people into the space: by address, or with a shareable link.
 *
 * The created link is shown once and only once, because the API stores only its digest and cannot
 * hand it back. That is why the field stays on screen with a copy button until the dialog is
 * closed, and why revoking and re-issuing is one click rather than a recovery flow.
 */
export function InviteDialog({
  onClose,
  canInvite,
  onCreate,
  invitations,
  onRevoke,
  emailDelivery,
}: InviteDialogProps) {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ url: string; emailed: boolean } | null>(null);
  const [copied, setCopied] = useState(false);

  const address = email.trim();
  const addressed = address.length > 0;
  const noRelay = emailDelivery === false;

  // An invitation that was taken up is finished, not broken. Listing it among the outstanding ones,
  // greyed out next to a Revoke button, read as a failure that still needed cleaning up.
  const outstanding = invitations.filter((invitation) => invitation.status === "active");
  const finished = invitations.filter((invitation) => invitation.status !== "active");

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
      setError("dialogs.inviteFailed");
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
      title={t("sidebar.invitePeople")}
      closeLabel={t("common.close")}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t("common.close")}</Button>
          {canInvite ? (
            <Button
              variant="primary"
              iconLeft={addressed ? "send" : "external-link"}
              disabled={pending}
              onClick={() => void submit()}
            >
              {addressed ? t("dialogs.sendInvite") : t("dialogs.createLink")}
            </Button>
          ) : null}
        </>
      }
    >
      {!canInvite ? (
        <p style={inviteStyles.empty}>
          {t("dialogs.cannotInvite")}
        </p>
      ) : (
      <div style={inviteStyles.body}>
        <Field
          label={t("login.email")}
          hint={
            noRelay
              ? t("dialogs.noRelayHint")
              : t("dialogs.emailHint")
          }
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
        <Field label={t("dialogs.roleOnArrival")} htmlFor="inv-role">
          <Select
            id="inv-role"
            options={INVITE_ROLES.map((r) => ({ value: r.value, label: t(r.labelKey) }))}
            value={role}
            onChange={(e) => setRole(e.target.value)}
          />
        </Field>

        {noRelay && !addressed ? (
          <p style={inviteStyles.notice}>
            Un lien partageable mène à un compte en attente de confirmation d&apos;adresse, et cette instance ne peut
            envoyer aucun courriel de confirmation. Indiquez une adresse : une invitation nominative active le compte
            immédiatement.
          </p>
        ) : null}

        {error ? (
          <p role="alert" style={{ ...inviteStyles.empty, color: "var(--text-danger, var(--terracotta-700))" }}>
            {error}
          </p>
        ) : null}

        {created ? (
          <div style={inviteStyles.section}>
            <div style={inviteStyles.sectionTitle}>
              {created.emailed ? t("dialogs.inviteSent") : t("dialogs.inviteLink")}
            </div>
            <p style={inviteStyles.empty}>
              {created.emailed ? t("dialogs.emailedHint") : t("dialogs.copyNowHint")}
            </p>
            <div style={inviteStyles.link}>
              <span style={inviteStyles.linkText}>{created.url}</span>
              <Button size="sm" iconLeft={copied ? "check" : "copy"} onClick={copy}>
                {copied ? t("common.copied") : t("admin.copy")}
              </Button>
            </div>
          </div>
        ) : null}

        <div style={inviteStyles.section}>
          <div style={inviteStyles.sectionTitle}>{t("dialogs.outstanding")}</div>
          {outstanding.length === 0 ? (
            <p style={inviteStyles.empty}>{t("dialogs.noOutstanding")}</p>
          ) : (
            outstanding.map((invitation) => (
              <div key={invitation.id} style={inviteStyles.row}>
                <div style={inviteStyles.rowMain}>
                  <div>{invitation.email ?? t("dialogs.shareableLink")}</div>
                  <div style={inviteStyles.rowMeta}>{describeInvitation(invitation, t)}</div>
                </div>
                <Button size="sm" iconLeft="x" onClick={() => void onRevoke(invitation.id)}>
                  {t("dialogs.revoke")}
                </Button>
              </div>
            ))
          )}
        </div>

        {/*
          Finished invitations, kept visible but out of the way: they answer "has this person joined
          yet?", and nothing about them is actionable, so they carry no button.
        */}
        {finished.length > 0 ? (
          <div style={inviteStyles.section}>
            <div style={inviteStyles.sectionTitle}>{t("dialogs.finished")}</div>
            {finished.map((invitation) => (
              <div key={invitation.id} style={inviteStyles.row}>
                <div style={inviteStyles.rowMain}>
                  <div style={{ color: "var(--text-muted)" }}>{invitation.email ?? "Lien partageable"}</div>
                  <div style={inviteStyles.rowMeta}>{describeInvitation(invitation, t)}</div>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      )}
    </Dialog>
  );
}

/** Create a new workspace. */
export function NewWorkspaceDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string) => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const submit = () => {
    const clean = name.trim();
    if (!clean) return;
    onCreate(clean);
  };

  return (
    <Dialog
      title={t("dialogs.newWorkspace")}
      closeLabel={t("common.close")}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={submit}>
            Créer l&apos;espace
          </Button>
        </>
      }
    >
      <Field label={t("onboarding.spaceName")} hint={t("dialogs.workspaceHint")} htmlFor="ws-name">
        <Input
          id="ws-name"
          autoFocus
          placeholder={t("dialogs.workspacePlaceholder")}
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
  const { t } = useTranslation();
  const mac = isMac();
  return (
    <Dialog title={t("common.help")} subtitle={t("dialogs.helpSubtitle")} size="md" onClose={onClose} closeLabel={t("common.close")}>
      {/*
        One entry, because one is all that leads anywhere. The other two ("Raccourcis clavier et
        astuces", "Contacter le support") were inert: the first duplicated the shortcut list printed
        just below, and the second had no destination at all, this product having no support address
        to send anyone to yet. They come back when there is something behind them.
      */}
      {onGettingStarted ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 18 }}>
          <button
            type="button"
            onClick={onGettingStarted}
            style={{ ...listItem, textAlign: "left", border: 0, background: "transparent", cursor: "pointer", color: "var(--text-strong)", font: "inherit" }}
            className="wc-listrow"
          >
            <Icon name="file-text" size={16} style={{ color: "var(--text-muted)" }} />
            <span style={{ flex: 1, fontSize: 13 }}>{t("dialogs.gettingStartedGuide")}</span>
            <Icon name="chevron-right" size={13} style={{ color: "var(--text-subtle)" }} />
          </button>
        </div>
      ) : null}
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
          const keys = formatChord(shortcuts[c.id], mac, t);
          return (
            <div key={c.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "6px 2px" }}>
              <span style={{ fontSize: 13, color: "var(--text-body)" }}>{t(c.label)}</span>
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
                <span style={{ fontSize: 12, color: "var(--text-subtle)" }}>{t("dialogs.unassigned")}</span>
              )}
            </div>
          );
        })}
      </div>
    </Dialog>
  );
}
