"use client";

import { type CSSProperties, useEffect, useState } from "react";
import { Button, FileIcon, Icon, Input, Skeleton, SkeletonGroup } from "@/components/ds";
import { getPublicLink, publicDownloadUrl, publicThumbnailUrl, type PublicLink, unlockLink } from "@/lib/data/api";
import { isApiError } from "@/lib/data/http";
import { useTranslation } from "@/lib/i18n";
import { formatBytes, formatDate } from "@/lib/i18n/format";

const styles: Record<string, CSSProperties> = {
  page: {
    minHeight: "var(--ui-vh, 100vh)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 18,
    padding: "32px 16px calc(32px + env(safe-area-inset-bottom))",
    background: "var(--surface-canvas)",
  },
  card: {
    width: "100%",
    maxWidth: 440,
    padding: 24,
    borderRadius: "var(--radius-lg)",
    border: "1px solid var(--border-subtle)",
    background: "var(--surface-card)",
    display: "flex",
    flexDirection: "column",
    gap: 14,
  },
  preview: {
    height: 200,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-md)",
    background: "var(--surface-sunken)",
    overflow: "hidden",
  },
  title: { margin: 0, fontSize: "var(--text-lg)", fontWeight: 700, color: "var(--text-strong)", overflowWrap: "anywhere" },
  meta: { margin: 0, fontSize: "var(--text-xs)", color: "var(--text-muted)", lineHeight: "var(--leading-normal)" },
};

type State =
  | { kind: "loading" }
  | { kind: "gone" }
  | { kind: "password"; wrong: boolean }
  | { kind: "file"; link: Extract<PublicLink, { needsPassword: false }>; grant?: string };

/**
 * What someone outside the space sees of a file handed to them: its name, size, who shared it and
 * until when, a picture when it is an image, and the download. A protected link asks for its
 * password before showing anything; a dead one says so, the same way whatever killed it.
 */
export function PublicShareScreen() {
  const { t } = useTranslation();
  const [token, setToken] = useState("");
  const [state, setState] = useState<State>({ kind: "loading" });
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const found = new URLSearchParams(window.location.search).get("t") ?? "";
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the address is read once, on the client
    setToken(found);
    if (!found) {
      setState({ kind: "gone" });
      return;
    }
    getPublicLink(found)
      .then((link) => setState(link.needsPassword ? { kind: "password", wrong: false } : { kind: "file", link }))
      .catch(() => setState({ kind: "gone" }));
  }, []);

  const unlock = () => {
    if (!password || busy) return;
    setBusy(true);
    unlockLink(token, password)
      .then(({ grant, link }) => {
        if (!link.needsPassword) setState({ kind: "file", link, grant });
      })
      .catch((err) => setState(isApiError(err, 403) ? { kind: "password", wrong: true } : { kind: "gone" }))
      .finally(() => setBusy(false));
  };

  return (
    <main style={styles.page}>
      {/* eslint-disable-next-line @next/next/no-img-element -- the self-hosted brand mark */}
      <img src="/brand/ruchoir-mark.png" alt="Ruchoir" width={40} height={40} />
      <div style={styles.card}>
        {state.kind === "loading" ? (
          <SkeletonGroup label={t("share.loading")}>
            <Skeleton width="100%" height={200} />
            <Skeleton width="70%" height={16} />
            <Skeleton width="40%" height={12} />
          </SkeletonGroup>
        ) : state.kind === "gone" ? (
          <>
            <div style={{ ...styles.preview, height: 140 }}>
              <Icon name="circle-alert" size={40} style={{ color: "var(--text-muted)" }} />
            </div>
            <h1 style={styles.title}>{t("share.goneTitle")}</h1>
            <p style={styles.meta}>{t("share.goneText")}</p>
          </>
        ) : state.kind === "password" ? (
          <>
            <div style={{ ...styles.preview, height: 140 }}>
              <Icon name="lock" size={40} style={{ color: "var(--text-muted)" }} />
            </div>
            <h1 style={styles.title}>{t("share.protectedTitle")}</h1>
            <p style={styles.meta}>{t("share.protectedText")}</p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                unlock();
              }}
              style={{ display: "flex", flexDirection: "column", gap: 10 }}
            >
              <Input
                type="password"
                autoFocus
                autoComplete="off"
                aria-label={t("login.password")}
                placeholder={t("login.password")}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              {state.wrong ? (
                <p role="alert" style={{ ...styles.meta, color: "var(--status-danger-fg)" }}>
                  {t("security.wrongPassword")}
                </p>
              ) : null}
              <Button type="submit" variant="primary" iconLeft="lock" disabled={busy || !password}>
                {t("share.unlock")}
              </Button>
            </form>
          </>
        ) : (
          <>
            <div style={styles.preview}>
              {state.link.hasThumbnail ? (
                // eslint-disable-next-line @next/next/no-img-element -- same-origin, served by our own API
                <img src={publicThumbnailUrl(token, state.grant)} alt="" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
              ) : (
                <FileIcon name={state.link.name} size={80} />
              )}
            </div>
            <h1 style={styles.title}>{state.link.name}</h1>
            <p style={styles.meta}>
              {[formatBytes(state.link.sizeBytes), state.link.sharedBy ? t("share.sharedBy", { name: state.link.sharedBy }) : null]
                .filter(Boolean)
                .join(" · ")}
              {state.link.expiresAt ? (
                <>
                  <br />
                  {t("share.availableUntil", { date: formatDate(state.link.expiresAt) })}
                </>
              ) : null}
            </p>
            <a
              href={publicDownloadUrl(token, state.grant)}
              download={state.link.name}
              className="wc-btn wc-btn--primary wc-btn--md"
              style={{ justifyContent: "center", textDecoration: "none" }}
            >
              <Icon name="download" size={16} />
              {t("message.download")}
            </a>
          </>
        )}
      </div>
      <p style={{ ...styles.meta, textAlign: "center" }}>{t("share.footer")}</p>
    </main>
  );
}
