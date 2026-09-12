import { type CSSProperties, type FormEvent, useEffect, useState } from "react";
import { Button, Field, Icon, Input, Switch, Tag } from "@/components/ds";
import {
  getInstanceSettings,
  issuePasswordResetLink,
  searchAccounts,
  updateInstanceSettings,
  type AdminUser,
} from "@/lib/data/api";
import type { Toast } from "./types";

/**
 * Instance administration: handing an account back to someone locked out of it.
 *
 * An instance is allowed to run without a mail relay, which is a supported configuration and, for a
 * self-hosted server on a residential connection, often the only practical one. Someone who has
 * forgotten their password and has no recovery code left then has no self-service way back in. This
 * is that way: an administrator issues a single-use link and hands it over by whatever channel they
 * have.
 *
 * The administrator never sees or sets the password. Nothing about the account changes when the link
 * is issued either: the existing password keeps working until its holder uses the link, which is
 * what makes issuing one safe when it turns out to reach the wrong person.
 */

const st: Record<string, CSSProperties> = {
  sub: { fontSize: 13, color: "var(--text-muted)", margin: "0 0 18px", maxWidth: 560, lineHeight: 1.5 },
  form: { display: "flex", gap: 8, alignItems: "flex-end", maxWidth: 560 },
  row: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "12px 0",
    borderBottom: "1px solid var(--border-subtle)",
  },
  main: { flex: 1, minWidth: 0 },
  name: { fontSize: 13, fontWeight: 500, color: "var(--text-strong)" },
  meta: { fontSize: 12, color: "var(--text-muted)", marginTop: 2 },
  empty: { fontSize: 13, color: "var(--text-muted)", padding: "12px 0" },
  issued: {
    marginTop: 16,
    padding: 14,
    borderRadius: "var(--radius-md)",
    background: "var(--surface-sunken)",
    border: "1px solid var(--border-subtle)",
  },
  link: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginTop: 10,
    padding: "8px 10px",
    background: "var(--surface-default)",
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
};

/** The link just issued, held only until the screen is left. */
type Issued = { user: AdminUser; url: string; expiresInSecs: number };

export function InstanceAdminSection({ onNotify }: { onNotify?: (t: Toast) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AdminUser[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [copied, setCopied] = useState(false);

  // The accounts are listed as soon as the screen opens. On a self-hosted instance there are tens of
  // them, and reading the list is faster than recalling how a colleague spelled their name; the
  // search narrows it when there are enough to need narrowing.
  useEffect(() => {
    let active = true;
    searchAccounts("")
      .then((rows) => active && setResults(rows))
      .catch(() => active && setError("La liste des comptes n'a pas pu être chargée."));
    return () => {
      active = false;
    };
  }, []);

  const search = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setIssued(null);
    try {
      setResults(await searchAccounts(query.trim()));
    } catch {
      setError("La recherche a échoué. Réessayez.");
    } finally {
      setBusy(false);
    }
  };

  const issue = async (user: AdminUser) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const { url, expiresInSecs } = await issuePasswordResetLink(user.id);
      setIssued({ user, url, expiresInSecs });
    } catch {
      setError("Ce lien n'a pas pu être émis. Réessayez.");
    } finally {
      setBusy(false);
    }
  };

  const copy = () => {
    if (!issued) return;
    void navigator.clipboard?.writeText(issued.url).then(
      () => {
        setCopied(true);
        onNotify?.({ tone: "success", title: "Lien copié" });
      },
      () => setCopied(false),
    );
  };

  return (
    <>
      <p style={st.sub}>
        Pour quelqu&apos;un qui ne peut plus se connecter et n&apos;a plus de code de récupération. Vous lui
        transmettez le lien vous-même, de vive voix ou par un autre canal : vous ne voyez jamais son mot de passe, et
        celui qu&apos;il a aujourd&apos;hui continue de fonctionner tant qu&apos;il n&apos;a pas ouvert le lien.
      </p>

      <form style={st.form} onSubmit={search}>
        <Field label="Filtrer les comptes" htmlFor="admin-q" style={{ flex: 1 }}>
          <Input
            id="admin-q"
            icon="search"
            placeholder="Nom ou adresse électronique"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </Field>
        <Button variant="primary" type="submit" disabled={busy}>
          {query.trim().length === 0 ? "Tout afficher" : "Rechercher"}
        </Button>
      </form>

      {error ? (
        <p role="alert" style={{ ...st.empty, color: "var(--text-danger, var(--terracotta-700))" }}>
          {error}
        </p>
      ) : null}

      {results === null ? (
        <p style={st.empty}>Chargement des comptes…</p>
      ) : results.length === 0 ? (
        <p style={st.empty}>Aucun compte ne correspond.</p>
      ) : (
        <div style={{ marginTop: 8 }}>
          {results.map((user) => (
            <div key={user.id} style={st.row}>
              <div style={st.main}>
                <div style={st.name}>
                  {user.name}
                  {user.isInstanceAdmin ? (
                    <span style={{ marginLeft: 8 }}>
                      <Tag tone="accent">Administrateur</Tag>
                    </span>
                  ) : null}
                </div>
                <div style={st.meta}>
                  {user.email}
                  {user.status === "active" ? "" : ` · ${user.status === "pending" ? "en attente" : "verrouillé"}`}
                </div>
              </div>
              <Button size="sm" iconLeft="shield" disabled={busy} onClick={() => void issue(user)}>
                Émettre un lien
              </Button>
            </div>
          ))}
        </div>
      )}

      {issued ? (
        <div style={st.issued}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Icon name="shield" size={16} style={{ color: "var(--text-accent)" }} />
            <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text-strong)" }}>
              Lien pour {issued.user.name}
            </span>
          </div>
          <p style={{ ...st.meta, marginTop: 6 }}>
            À usage unique, valable {Math.round(issued.expiresInSecs / 60)} minutes. Il ne sera plus affiché après
            avoir quitté cet écran.
          </p>
          <div style={st.link}>
            <span style={st.linkText}>{issued.url}</span>
            <Button size="sm" iconLeft={copied ? "check" : "copy"} onClick={copy}>
              {copied ? "Copié" : "Copier"}
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}

/**
 * Instance settings.
 *
 * One setting today, and it is a real trade-off rather than a preference: showing who administers
 * the instance is what makes "ask an administrator" actionable for someone locked out, and it also
 * designates a person to anyone who can open the app. An instance of a dozen colleagues wants it on;
 * one that would rather not point at anyone turns it off, and administrators still see each other.
 */
function InstanceSettingsSection({ onNotify }: { onNotify?: (t: Toast) => void }) {
  const [showAdmins, setShowAdmins] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getInstanceSettings()
      .then((settings) => active && setShowAdmins(settings.showInstanceAdmins))
      .catch(() => active && setError("Les réglages n'ont pas pu être chargés."));
    return () => {
      active = false;
    };
  }, []);

  const toggle = async (next: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    // Moved at once, because a switch that waits for the network reads as broken; the answer is what
    // is kept, so a refusal puts it back where it was rather than where the click left it.
    setShowAdmins(next);
    try {
      const saved = await updateInstanceSettings({ showInstanceAdmins: next });
      setShowAdmins(saved.showInstanceAdmins);
      onNotify?.({
        tone: "success",
        title: saved.showInstanceAdmins ? "Administrateurs visibles" : "Administrateurs masqués",
      });
    } catch {
      setShowAdmins(!next);
      setError("Ce réglage n'a pas pu être enregistré.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p style={st.sub}>
        Ce que l&apos;instance applique à tout le monde, quel que soit l&apos;espace.
      </p>

      <div style={st.row}>
        <div style={st.main}>
          <div style={st.name}>Afficher qui administre l&apos;instance</div>
          <div style={{ ...st.meta, maxWidth: 460, lineHeight: 1.5 }}>
            Un badge sur le profil des administrateurs. C&apos;est ce qui permet à quelqu&apos;un qui a perdu son
            mot de passe et ses codes de récupération de savoir à qui s&apos;adresser. Désactivé, le badge n&apos;est
            plus visible que par les administrateurs eux-mêmes.
          </div>
        </div>
        <Switch
          checked={showAdmins ?? true}
          disabled={busy || showAdmins === null}
          onChange={(e) => void toggle(e.target.checked)}
          aria-label="Afficher qui administre l'instance"
        />
      </div>

      {error ? (
        <p role="alert" style={{ ...st.empty, color: "var(--text-danger, var(--terracotta-700))" }}>
          {error}
        </p>
      ) : null}
    </>
  );
}

/** Chrome of the full-screen view, matching the preferences screen it sits next to. */
const screen: Record<string, CSSProperties> = {
  top: {
    height: "var(--topbar-height)",
    flex: "none",
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "0 12px",
    borderBottom: "1px solid var(--border-subtle)",
  },
  mark: { width: 22, height: 22, flex: "none", display: "block" },
  wordmark: {
    fontFamily: "var(--font-sans)",
    fontSize: 16,
    fontWeight: 600,
    letterSpacing: "var(--tracking-display)",
    color: "var(--text-strong)",
  },
  divider: { width: 1, height: 20, flex: "none", background: "var(--border-subtle)", margin: "0 2px" },
  title: {
    margin: 0,
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: 15,
    fontWeight: 600,
    letterSpacing: "var(--tracking-tight)",
    color: "var(--text-strong)",
  },
  // The row itself never scrolls: the nav stays put while a long section scrolls beside it, exactly
  // as in the preferences.
  body: { flex: 1, overflow: "hidden", display: "flex", minWidth: 0, minHeight: 0 },
  nav: {
    width: 200,
    flex: "none",
    padding: "16px 8px",
    borderRight: "1px solid var(--border-subtle)",
    overflowY: "auto",
  },
  scroller: { flex: 1, minWidth: 0, overflowY: "auto" },
  main: { padding: "24px 28px 64px", maxWidth: 760 },
  h: { fontSize: 18, marginBottom: 4 },
};

/** The sections of the administration screen. */
type AdminTab = "accounts" | "settings";

const ADMIN_NAV: [AdminTab, string, string][] = [
  ["accounts", "Comptes", "users"],
  ["settings", "Réglages", "settings"],
];

/** One nav entry, styled like the preferences one so the two screens read as the same furniture. */
function navItem(on: boolean, compact: boolean): CSSProperties {
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

/**
 * The instance-administration view.
 *
 * A screen of its own rather than a tab of the preferences: nothing here is a personal preference,
 * and nothing here belongs to the space on screen either. It is reached from the account menu, which
 * is the one place in the app that is already about the account rather than about a space, and it
 * appears there only for an administrator.
 */
export function InstanceAdminScreen({
  onClose,
  onNotify,
  compact = false,
}: {
  onClose: () => void;
  onNotify?: (t: Toast) => void;
  compact?: boolean;
}) {
  const [tab, setTab] = useState<AdminTab>("accounts");

  // Escape leaves the screen, but only when no dialog is open (a dialog handles Escape first).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (document.querySelector('[role="dialog"]')) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
      <div style={screen.top}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/ruchoir-mark.png" alt="" style={screen.mark} />
        {compact ? null : <span style={screen.wordmark}>Ruchoir</span>}
        <span style={screen.divider} aria-hidden />
        <h1 style={screen.title}>Administration de l&apos;instance</h1>
        <Button variant="secondary" iconLeft="arrow-left" onClick={onClose} style={{ flexShrink: 0 }}>
          {compact ? "Retour" : "Retour à l'espace"}
        </Button>
      </div>
      <div style={compact ? { ...screen.body, flexDirection: "column" } : screen.body}>
        <div
          style={
            compact
              ? { flex: "none", display: "flex", flexWrap: "wrap", gap: 6, padding: "8px 12px", borderBottom: "1px solid var(--border-subtle)" }
              : screen.nav
          }
        >
          {ADMIN_NAV.map(([v, label, icon]) => (
            <button key={v} style={navItem(v === tab, compact)} onClick={() => setTab(v)}>
              <Icon name={icon} size={14} style={{ color: "var(--text-muted)" }} />
              {label}
            </button>
          ))}
        </div>

        <div style={screen.scroller}>
          <div style={compact ? { ...screen.main, padding: "16px 16px 48px" } : screen.main}>
            {tab === "accounts" ? (
              <>
                <h2 style={screen.h}>Rendre l&apos;accès à un compte</h2>
                <InstanceAdminSection onNotify={onNotify} />
              </>
            ) : (
              <>
                <h2 style={screen.h}>Réglages de l&apos;instance</h2>
                <InstanceSettingsSection onNotify={onNotify} />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
