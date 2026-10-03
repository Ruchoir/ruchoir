"use client";

import { type CSSProperties, useEffect, useState } from "react";
import { Button, FileIcon, Icon, Input, Skeleton, SkeletonGroup } from "@/components/ds";
import {
  getPublicLink,
  publicDocumentUrl,
  publicDownloadUrl,
  type PublicLink,
  publicPageUrl,
  publicPreviewUrl,
  unlockLink,
} from "@/lib/data/api";
import { isApiError } from "@/lib/data/http";
import { useTranslation } from "@/lib/i18n";
import { formatBytes, formatDate } from "@/lib/i18n/format";
import { useCompact } from "@/features/app/useCompact";

/** The longest text shown in the page; the rest is in the download. */
const TEXT_LIMIT = 200_000;

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
  stage: {
    position: "relative",
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

type File = Extract<PublicLink, { needsPassword: false }>;

type State =
  | { kind: "loading" }
  | { kind: "gone" }
  | { kind: "password"; wrong: boolean }
  | { kind: "file"; link: File; grant?: string };

/**
 * What someone outside the space sees of a file handed to them: the file itself when the page can
 * show it (a document read in the page, a picture, a video or a sound played, a text), its name, size,
 * who shared it and until when, and the download. A protected link asks for its password before
 * showing anything; a dead one says so, the same way whatever killed it.
 *
 * On a phone a PDF does not show inside a page, so a document is its first page, with a button that
 * opens the whole of it in the phone's own reader.
 */
export function PublicShareScreen() {
  const { t } = useTranslation();
  const narrow = useCompact(760);
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

  const mark = (
    // eslint-disable-next-line @next/next/no-img-element -- the self-hosted brand mark
    <img src="/brand/ruchoir-mark.png" alt="Ruchoir" width={40} height={40} />
  );
  const footer = <p style={{ ...styles.meta, textAlign: "center" }}>{t("share.footer")}</p>;

  if (state.kind === "file" && state.link.preview) {
    return (
      <main style={{ ...styles.page, justifyContent: "flex-start" }}>
        {mark}
        <FileView token={token} link={state.link} grant={state.grant} narrow={narrow} />
        {footer}
      </main>
    );
  }

  return (
    <main style={styles.page}>
      {mark}
      <div style={styles.card}>
        {state.kind === "loading" ? (
          <SkeletonGroup label={t("share.loading")}>
            <Skeleton width="100%" height={200} />
            <Skeleton width="70%" height={16} />
            <Skeleton width="40%" height={12} />
          </SkeletonGroup>
        ) : state.kind === "gone" ? (
          <>
            <div style={{ ...styles.stage, height: 140 }}>
              <Icon name="circle-alert" size={40} style={{ color: "var(--text-muted)" }} />
            </div>
            <h1 style={styles.title}>{t("share.goneTitle")}</h1>
            <p style={styles.meta}>{t("share.goneText")}</p>
          </>
        ) : state.kind === "password" ? (
          <>
            <div style={{ ...styles.stage, height: 140 }}>
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
            <div style={{ ...styles.stage, height: 200 }}>
              <FileIcon name={state.link.name} size={80} />
            </div>
            <Heading link={state.link} />
            <DownloadButton token={token} link={state.link} grant={state.grant} />
          </>
        )}
      </div>
      {footer}
    </main>
  );
}

function Heading({ link }: { link: File }) {
  const { t } = useTranslation();
  return (
    <div style={{ minWidth: 0 }}>
      <h1 style={styles.title}>{link.name}</h1>
      <p style={{ ...styles.meta, marginTop: 4 }}>
        {[formatBytes(link.sizeBytes), link.sharedBy ? t("share.sharedBy", { name: link.sharedBy }) : null].filter(Boolean).join(" · ")}
        {link.expiresAt ? (
          <>
            <br />
            {t("share.availableUntil", { date: formatDate(link.expiresAt) })}
          </>
        ) : null}
      </p>
    </div>
  );
}

function DownloadButton({ token, link, grant, compact = false }: { token: string; link: File; grant?: string; compact?: boolean }) {
  const { t } = useTranslation();
  return (
    <a
      href={publicDownloadUrl(token, grant)}
      download={link.name}
      className="wc-btn wc-btn--primary wc-btn--md"
      style={{ justifyContent: "center", textDecoration: "none", flex: compact ? "none" : undefined }}
    >
      <Icon name="download" size={16} />
      {t("message.download")}
    </a>
  );
}

/** A shared file shown for what it is, its name and the download above it. */
function FileView({ token, link, grant, narrow }: { token: string; link: File; grant?: string; narrow: boolean }) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const kind = link.preview;
  // On a phone a PDF is opened in the phone's reader rather than drawn in the page.
  const inPage = !narrow && (kind === "pdf" || kind === "document");
  const pdfUrl = kind === "document" ? publicDocumentUrl(token, grant) : publicPreviewUrl(token, grant);

  useEffect(() => {
    if (kind !== "text") return;
    const ctrl = new AbortController();
    fetch(publicPreviewUrl(token, grant), { signal: ctrl.signal })
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error(String(res.status)))))
      .then((body) => setText(body.length > TEXT_LIMIT ? `${body.slice(0, TEXT_LIMIT)}\n…` : body))
      .catch(() => !ctrl.signal.aborted && setFailed(true));
    return () => ctrl.abort();
  }, [kind, token, grant]);

  const stageHeight = narrow ? undefined : "calc(var(--ui-vh, 100vh) - 260px)";
  let stage: React.ReactNode;
  if (failed) {
    stage = <FileIcon name={link.name} size={80} />;
  } else if (kind === "image") {
    // eslint-disable-next-line @next/next/no-img-element -- same-origin, served by our own API
    stage = <img src={publicPreviewUrl(token, grant)} alt={link.name} style={{ maxWidth: "100%", maxHeight: narrow ? "60vh" : "100%", objectFit: "contain", display: "block" }} />;
  } else if (inPage) {
    stage = (
      <>
        <iframe
          src={pdfUrl}
          title={link.name}
          onLoad={() => setLoaded(true)}
          style={{ width: "100%", height: "100%", border: 0, background: "var(--surface-card)" }}
        />
        {loaded ? null : (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--surface-sunken)", ...styles.meta }}>
            {kind === "document" ? t("files.convertingDocument") : t("share.loading")}
          </div>
        )}
      </>
    );
  } else if (kind === "document") {
    // The first page, which opens the whole document when touched.
    stage = (
      <a href={pdfUrl} target="_blank" rel="noopener noreferrer" style={{ display: "block", width: "100%" }} aria-label={t("share.openDocument")}>
        {/* eslint-disable-next-line @next/next/no-img-element -- same-origin, served by our own API */}
        <img src={publicPageUrl(token, grant)} alt="" onError={() => setFailed(true)} style={{ width: "100%", display: "block", boxSizing: "border-box", background: "#fff", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-md)" }} />
      </a>
    );
  } else if (kind === "video") {
    stage = <video controls playsInline preload="metadata" src={publicPreviewUrl(token, grant)} style={{ width: "100%", maxHeight: narrow ? "60vh" : "100%", background: "#000" }} />;
  } else if (kind === "audio") {
    stage = (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 18, padding: 24, width: "100%" }}>
        <FileIcon name={link.name} size={72} />
        <audio controls preload="metadata" src={publicPreviewUrl(token, grant)} style={{ width: "100%", maxWidth: 520 }} />
      </div>
    );
  } else if (kind === "text") {
    stage =
      text === null ? (
        <span style={styles.meta}>{t("share.loading")}</span>
      ) : (
        <pre
          style={{
            margin: 0,
            width: "100%",
            height: "100%",
            maxHeight: narrow ? "60vh" : undefined,
            overflow: "auto",
            padding: 16,
            boxSizing: "border-box",
            background: "var(--surface-card)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            lineHeight: 1.6,
            color: "var(--text-body)",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            alignSelf: "stretch",
          }}
        >
          {text}
        </pre>
      );
  } else {
    // A PDF on a phone: its icon, and the reader one button away.
    stage = <FileIcon name={link.name} size={80} />;
  }

  return (
    <div style={{ ...styles.card, maxWidth: 1040, padding: narrow ? 16 : 20 }}>
      <div style={{ display: "flex", alignItems: narrow ? "stretch" : "center", flexDirection: narrow ? "column" : "row", gap: 14 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Heading link={link} />
        </div>
        <div style={{ display: "flex", gap: 8, flexDirection: narrow ? "column" : "row" }}>
          {!inPage && (kind === "pdf" || kind === "document") && !failed ? (
            <a href={pdfUrl} target="_blank" rel="noopener noreferrer" className="wc-btn wc-btn--secondary wc-btn--md" style={{ justifyContent: "center", textDecoration: "none" }}>
              <Icon name="eye" size={16} />
              {t("share.openDocument")}
            </a>
          ) : null}
          <DownloadButton token={token} link={link} grant={grant} compact={!narrow} />
        </div>
      </div>
      <div style={{ ...styles.stage, height: stageHeight, minHeight: narrow ? 160 : 360 }}>{stage}</div>
    </div>
  );
}
