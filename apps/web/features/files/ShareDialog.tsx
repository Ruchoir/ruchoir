"use client";

import { type CSSProperties, useEffect, useState } from "react";
import { Avatar, Button, Dialog, Field, Icon, IconButton, Input, Select, Skeleton, SkeletonGroup, Tag, Textarea } from "@/components/ds";
import type { SpaceFile } from "@/lib/data";
import { createLink, type FileLink, listLinks, revokeLink, sendMessage } from "@/lib/data/api";
import { useTranslation } from "@/lib/i18n";
import { formatDate } from "@/lib/i18n/format";
import type { Toast } from "../app/types";

/** A conversation a file can be sent into. */
export type ShareTarget = {
  id: string;
  name: string;
  kind: "channel" | "dm";
  /** A favourite channel: listed first. */
  fav?: boolean;
  /** When something was last said there (direct messages), for the order. */
  lastAt?: string;
};

/**
 * Every conversation, in the order a person looks for one: their favourite channels, then their
 * direct messages, latest first, then the other channels by name. Each group under its heading.
 */
function grouped(targets: ShareTarget[]): { key: string; items: ShareTarget[] }[] {
  const byName = (a: ShareTarget, b: ShareTarget) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  const favs = targets.filter((c) => c.kind === "channel" && c.fav).sort(byName);
  const dms = targets
    .filter((c) => c.kind === "dm")
    .sort((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? "") || byName(a, b));
  const channels = targets.filter((c) => c.kind === "channel" && !c.fav).sort(byName);
  return [
    { key: "favourites", items: favs },
    { key: "dms", items: dms },
    { key: "channels", items: channels },
  ].filter((g) => g.items.length > 0);
}

type Expiry = "never" | "7" | "30" | "date";

const section: CSSProperties = { margin: "0 0 10px", fontSize: "var(--text-sm)", fontWeight: 700, color: "var(--text-strong)" };
const muted: CSSProperties = { margin: "0 0 10px", fontSize: "var(--text-xs)", color: "var(--text-muted)", lineHeight: "var(--leading-normal)" };

/**
 * Sharing a file: sending it into a conversation (the way to show a file to someone in Ruchoir,
 * where the space's members already see its files), and, for whoever manages it, public links for
 * people outside the space, each with an optional end and password, copied, counted and revoked.
 */
export function ShareDialog({
  file,
  canManage,
  publicLinks,
  targets,
  onNotify,
  onClose,
}: {
  /** The file being shared (`null`: closed). */
  file: SpaceFile | null;
  canManage: boolean;
  /** Whether the instance allows public links. */
  publicLinks: boolean;
  targets: ShareTarget[];
  onNotify: (toast: Toast) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<ShareTarget | null>(null);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [links, setLinks] = useState<FileLink[] | null>(null);
  const [expiry, setExpiry] = useState<Expiry>("never");
  const [date, setDate] = useState("");
  const [password, setPassword] = useState("");
  const [creating, setCreating] = useState(false);
  const [openedFor, setOpenedFor] = useState<SpaceFile | null>(null);

  const manageLinks = canManage && publicLinks;
  // Every opening starts afresh.
  if (file && openedFor !== file) {
    setOpenedFor(file);
    setQuery("");
    setTarget(null);
    setNote("");
    setLinks(null);
    setExpiry("never");
    setDate("");
    setPassword("");
  }

  useEffect(() => {
    if (!file?.id || !manageLinks) return;
    const ctrl = new AbortController();
    listLinks(file.id, ctrl.signal)
      .then(setLinks)
      .catch(() => !ctrl.signal.aborted && setLinks([]));
    return () => ctrl.abort();
  }, [file?.id, manageLinks]);

  const found = targets.filter((c) => c.name.toLowerCase().includes(query.trim().toLowerCase()));
  const groups = grouped(found);
  const heading = (key: string) =>
    key === "favourites" ? t("sidebar.favourites") : key === "dms" ? t("sidebar.directMessages") : t("tabs.channels");

  const send = () => {
    if (!file?.id || !target || sending) return;
    setSending(true);
    sendMessage(target.id, note.trim(), { attachments: [file.id] })
      .then(() => {
        onNotify({
          tone: "success",
          title: t("files.sentTo", { name: target.kind === "channel" ? `#${target.name}` : target.name }),
          description: file.name,
        });
        onClose();
      })
      .catch(() => onNotify({ tone: "danger", title: t("files.sendFailed") }))
      .finally(() => setSending(false));
  };

  const copy = (link: FileLink) => {
    void navigator.clipboard
      ?.writeText(link.url)
      .then(() => onNotify({ tone: "success", title: t("admin.copiedToast") }))
      .catch(() => onNotify({ tone: "danger", title: t("files.linkCopyFailed"), description: link.url }));
  };

  const create = () => {
    if (!file?.id || creating) return;
    let expiresAt: string | undefined;
    if (expiry === "7" || expiry === "30") expiresAt = new Date(Date.now() + Number(expiry) * 86_400_000).toISOString();
    if (expiry === "date") {
      if (!date) return;
      // The end of the chosen day, where the person is.
      expiresAt = new Date(`${date}T23:59:59`).toISOString();
    }
    setCreating(true);
    createLink(file.id, { expiresAt, password: password.trim() || undefined })
      .then((link) => {
        setLinks((prev) => [link, ...(prev ?? [])]);
        setPassword("");
        copy(link);
      })
      .catch(() => onNotify({ tone: "danger", title: t("files.linkCreateFailed") }))
      .finally(() => setCreating(false));
  };

  const revoke = (link: FileLink) => {
    if (!file?.id) return;
    revokeLink(file.id, link.id)
      .then(() => {
        setLinks((prev) => prev?.filter((l) => l.id !== link.id) ?? prev);
        onNotify({ tone: "success", title: t("files.linkRevoked") });
      })
      .catch(() => onNotify({ tone: "danger", title: t("files.linkRevokeFailed") }));
  };

  const today = new Date().toISOString().slice(0, 10);

  return (
    <Dialog open={file != null} title={file ? t("files.shareTitle", { name: file.name }) : undefined} closeLabel={t("common.close")} size="md" onClose={onClose}>
      <h3 style={section}>{t("files.sendToConversation")}</h3>
      {target ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <Tag icon={target.kind === "channel" ? "hash" : undefined}>{target.name}</Tag>
          <Button size="sm" variant="ghost" onClick={() => setTarget(null)}>
            {t("files.changeConversation")}
          </Button>
        </div>
      ) : (
        <>
          <Input size="sm" icon="search" placeholder={t("files.findConversation")} value={query} onChange={(e) => setQuery(e.target.value)} />
          <div style={{ margin: "8px 0 4px", fontSize: "var(--text-2xs)", color: "var(--text-muted)" }}>
            {t("files.conversationCount", { count: found.length })}
          </div>
          {/* Every conversation, in a list that scrolls: none is left to be guessed at by name. */}
          <div
            role="listbox"
            aria-label={t("files.sendToConversation")}
            style={{ margin: "0 0 12px", maxHeight: 264, overflowY: "auto", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-md)", padding: 4 }}
          >
            {found.length === 0 ? (
              <p style={{ ...muted, margin: 8 }}>{t("files.noConversation")}</p>
            ) : (
              groups.map((g) => (
                <div key={g.key} role="group" aria-label={heading(g.key)}>
                  <div style={{ padding: "8px 8px 4px", fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--text-muted)" }}>{heading(g.key)}</div>
                  {g.items.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      role="option"
                      aria-selected={false}
                      onClick={() => setTarget(c)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        width: "100%",
                        minHeight: 40,
                        padding: "4px 8px",
                        border: 0,
                        borderRadius: "var(--radius-sm)",
                        background: "none",
                        font: "inherit",
                        fontSize: "var(--text-sm)",
                        color: "var(--text-strong)",
                        textAlign: "left",
                        cursor: "pointer",
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-hover)")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
                    >
                      {c.kind === "channel" ? <Icon name="hash" size={16} style={{ color: "var(--text-muted)" }} /> : <Avatar name={c.name} size={22} />}
                      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        </>
      )}
      {target ? (
        <>
          <Field label={t("files.shareNote")} htmlFor="share-note">
            <Textarea id="share-note" rows={2} value={note} placeholder={t("files.shareNotePlaceholder")} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
            <Button variant="primary" iconLeft="send" onClick={send} disabled={sending}>
              {t("composer.send")}
            </Button>
          </div>
        </>
      ) : null}

      {manageLinks ? (
        <div style={{ marginTop: 22, paddingTop: 18, borderTop: "1px solid var(--border-subtle)" }}>
          <h3 style={section}>{t("files.publicLinks")}</h3>
          <p style={muted}>{t("files.publicLinksHint")}</p>
          {links === null ? (
            <SkeletonGroup label={t("files.linksLoading")}>
              <Skeleton width="70%" height={12} />
            </SkeletonGroup>
          ) : (
            links.map((link) => (
              <div key={link.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderTop: "1px solid var(--border-subtle)" }}>
                <Icon name="globe" size={16} style={{ flex: "none", color: "var(--text-muted)" }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--text-strong)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {link.url}
                  </div>
                  <div style={{ fontSize: "var(--text-2xs)", color: link.expired ? "var(--status-danger-fg)" : "var(--text-muted)" }}>
                    {[
                      link.expired ? t("files.linkExpired") : link.expiresAt ? t("files.linkUntil", { date: formatDate(link.expiresAt) }) : t("files.linkNoEnd"),
                      link.hasPassword ? t("files.linkWithPassword") : null,
                      t("files.linkDownloads", { count: link.downloads }),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                </div>
                {link.expired ? null : <IconButton icon="copy" size="sm" label={t("message.copyLink")} onClick={() => copy(link)} />}
                <IconButton icon="trash-2" size="sm" label={t("files.revokeLink")} onClick={() => revoke(link)} />
              </div>
            ))
          )}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10, marginTop: 12 }}>
            <Field label={t("files.linkExpiry")} htmlFor="link-expiry">
              <Select id="link-expiry" value={expiry} onChange={(e) => setExpiry(e.target.value as Expiry)}>
                <option value="never">{t("files.linkNoEnd")}</option>
                <option value="7">{t("files.linkDays", { count: 7 })}</option>
                <option value="30">{t("files.linkDays", { count: 30 })}</option>
                <option value="date">{t("files.linkOnDate")}</option>
              </Select>
            </Field>
            {expiry === "date" ? (
              <Field label={t("files.linkDate")} htmlFor="link-date">
                <Input id="link-date" type="date" min={today} value={date} onChange={(e) => setDate(e.target.value)} />
              </Field>
            ) : null}
            <Field label={t("login.password")} htmlFor="link-password">
              <Input id="link-password" type="password" autoComplete="new-password" placeholder={t("files.linkPasswordPlaceholder")} value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
            <Button iconLeft="globe" onClick={create} disabled={creating || (expiry === "date" && !date)}>
              {t("dialogs.createLink")}
            </Button>
          </div>
        </div>
      ) : canManage && !publicLinks ? (
        <p style={{ ...muted, marginTop: 18 }}>{t("files.publicLinksOff")}</p>
      ) : null}
    </Dialog>
  );
}
