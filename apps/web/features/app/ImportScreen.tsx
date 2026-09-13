import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { Button, Field, Input, Tag } from "@/components/ds";
import { key, useTranslation } from "@/lib/i18n";
import {
  cancelImport,
  getImport,
  type ImportJob,
  type ImportPlan,
  planImport,
  startImport,
} from "@/lib/data/api";
import type { Toast } from "./types";

/**
 * Bringing a workspace over from another product.
 *
 * The shape of this screen is the whole argument of the feature: **nothing is written until the
 * plan has been read**. An administrator names an archive, sees exactly what would happen, and only
 * then starts it. What the export could not take is shown in its producer's own words, in full and
 * before the run, because an import that leaves things behind without saying so is the one failure
 * this chain exists to prevent.
 *
 * Only an instance administrator ever reaches this: the routes behind it answer 404 to everyone
 * else, so showing it to anyone else would show them a screen full of errors.
 */

const st: Record<string, CSSProperties> = {
  wrap: { padding: "24px 28px 48px", overflowY: "auto", height: "100%" },
  title: { fontSize: 20, fontWeight: 650, margin: "0 0 6px" },
  sub: { fontSize: 13, color: "var(--text-muted)", margin: "0 0 24px", maxWidth: 620, lineHeight: 1.5 },
  section: { marginTop: 28, maxWidth: 720 },
  h2: { fontSize: 15, fontWeight: 600, margin: "0 0 10px" },
  form: { display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" },
  card: {
    border: "1px solid var(--border)",
    borderRadius: 10,
    padding: "14px 16px",
    background: "var(--surface)",
    marginBottom: 10,
  },
  row: { display: "flex", justifyContent: "space-between", gap: 12, padding: "5px 0", fontSize: 13 },
  muted: { color: "var(--text-muted)" },
  list: { margin: "8px 0 0", paddingLeft: 18, fontSize: 13, lineHeight: 1.6, color: "var(--text-muted)" },
  danger: {
    border: "1px solid var(--danger-border, var(--border))",
    borderRadius: 10,
    padding: "14px 16px",
    marginTop: 24,
  },
  bar: { height: 6, borderRadius: 999, background: "var(--surface-sunken, var(--border))", overflow: "hidden" },
  fill: { height: "100%", background: "var(--accent)", transition: "width .3s ease" },
};

/** How often a running import is asked where it has got to. */
const POLL_MS = 2000;

export function ImportScreen({
  onClose,
  onNotify,
  instanceAddress,
}: {
  onClose: () => void;
  onNotify?: (t: Toast) => void;
  /** The address this instance answers on, which is what a replacement asks to be typed back. */
  instanceAddress: string;
}) {
  const { t } = useTranslation();
  const [file, setFile] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [job, setJob] = useState<ImportJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [replace, setReplace] = useState(false);
  const [typedAddress, setTypedAddress] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fail = useCallback(
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      onNotify?.({ tone: "danger", title: message });
    },
    [onNotify],
  );

  // A running import is asked where it is, rather than told: an import writes for minutes or hours
  // and one frame per two seconds is more than anybody reads.
  useEffect(() => {
    if (!job || (job.status !== "running" && job.status !== "cancelling")) return;
    timer.current = setTimeout(() => {
      getImport(job.id).then(setJob).catch(fail);
    }, POLL_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [job, fail]);

  const look = async () => {
    setBusy(true);
    try {
      setPlan(await planImport(file.trim(), passphrase || undefined));
    } catch (error) {
      setPlan(null);
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const begin = async () => {
    setBusy(true);
    try {
      setJob(await startImport(file.trim(), passphrase || undefined, replace ? typedAddress : undefined));
      // The passphrase is not kept a moment longer than the request that used it.
      setPassphrase("");
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (!job) return;
    try {
      setJob(await cancelImport(job.id));
    } catch (error) {
      fail(error);
    }
  };

  const running = job?.status === "running" || job?.status === "cancelling";
  const dying = plan?.replacingWouldDestroy;

  return (
    <div style={st.wrap}>
      <h1 style={st.title}>{t(key("import.screenTitle"))}</h1>
      <p style={st.sub}>{t(key("import.intro"))}</p>

      {/* Step one: name the archive. A name, never a path: the server reads only its import
          directory, and an administrator is trusted with the instance rather than handed a way to
          have it open any file on the machine. */}
      <div style={st.form}>
        <Field label={t(key("import.fileLabel"))} hint={t(key("import.fileHint"))}>
          <Input value={file} onChange={(e) => setFile(e.target.value)} placeholder="export.tar.gpg" />
        </Field>
        <Field label={t(key("import.passphraseLabel"))} hint={t(key("import.passphraseHint"))}>
          <Input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            autoComplete="off"
          />
        </Field>
        <Button onClick={look} disabled={!file.trim() || busy || running}>
          {t(key("import.look"))}
        </Button>
      </div>

      {plan ? (
        <>
          <div style={st.section}>
            <h2 style={st.h2}>{t(key("import.wouldArrive"))}</h2>
            {plan.spaces.map((space) => (
              <div key={space.name} style={st.card}>
                <div style={st.row}>
                  <strong>{space.name}</strong>
                  {/* Both keys written out: the audit reads the source for its call sites, and a
                      key assembled at runtime is a key nobody can find again. */}
                  <Tag tone={space.outcome === "created" ? "accent" : "neutral"}>
                    {space.outcome === "created"
                      ? t(key("import.spaceCreated"))
                      : t(key("import.spaceFilled"))}
                  </Tag>
                </div>
                <div style={{ ...st.row, ...st.muted }}>
                  <span>
                    {space.channels} · {space.directs}
                  </span>
                </div>
              </div>
            ))}
            <div style={st.card}>
              <div style={st.row}>
                <span>{t(key("import.accounts"))}</span>
                <strong>{plan.accounts.total}</strong>
              </div>
              <div style={{ ...st.row, ...st.muted }}>
                <span>{t(key("import.accountsMatched"))}</span>
                <span>{plan.accounts.matched}</span>
              </div>
              <div style={{ ...st.row, ...st.muted }}>
                <span>{t(key("import.accountsInvitable"))}</span>
                <span>{plan.accounts.invitable}</span>
              </div>
              {/* Said plainly rather than counted quietly: these people arrive placed and cannot be
                  emailed, so somebody has to give them an address or hand them a link. */}
              {plan.accounts.withoutAddress > 0 ? (
                <div style={st.row}>
                  <span>{t(key("import.accountsWithoutAddress"))}</span>
                  <strong>{plan.accounts.withoutAddress}</strong>
                </div>
              ) : null}
            </div>
            <div style={st.card}>
              <div style={st.row}>
                <span>{t(key("import.messages"))}</span>
                <strong>{plan.messages}</strong>
              </div>
              <div style={st.row}>
                <span>{t(key("import.files"))}</span>
                <strong>{plan.files}</strong>
              </div>
            </div>
          </div>

          {/* In the producer's own words, in full. Summarising a declared loss is another way of
              hiding it. */}
          {plan.limits.length > 0 ? (
            <div style={st.section}>
              <h2 style={st.h2}>{t(key("import.leftBehind"))}</h2>
              <ul style={st.list}>
                {plan.limits.map((limit) => (
                  <li key={limit}>{limit}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {plan.warnings.length > 0 ? (
            <div style={st.section}>
              <h2 style={st.h2}>{t(key("import.warnings"))}</h2>
              <ul style={st.list}>
                {plan.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {!running && !job ? (
            <>
              <div style={st.section}>
                <Button onClick={begin} disabled={busy || (replace && typedAddress.trim() !== instanceAddress)}>
                  {t(key("import.start"))}
                </Button>
                <p style={{ ...st.sub, marginTop: 10 }}>{t(key("import.startNote"))}</p>
              </div>

              {/* The destructive door, closed by default, and never a default. */}
              <div style={st.danger}>
                <h2 style={st.h2}>{t(key("import.replaceTitle"))}</h2>
                <p style={st.sub}>{t(key("import.replaceExplain"))}</p>
                {dying ? (
                  <>
                    <div style={st.row}>
                      <span>{t(key("import.replaceWouldDestroy"))}</span>
                      <strong>
                        {dying.spaces} · {dying.accounts} · {dying.messages}
                      </strong>
                    </div>
                    {dying.spaceNames.length > 0 ? (
                      <ul style={st.list}>
                        {dying.spaceNames.map((name) => (
                          <li key={name}>{name}</li>
                        ))}
                      </ul>
                    ) : null}
                    {/* Without a recent backup this is simply destruction, so the door stays shut. */}
                    {!dying.replacementAllowed ? (
                      <p style={{ ...st.sub, marginTop: 12 }}>{t(key("import.replaceNoBackup"))}</p>
                    ) : (
                      <>
                        <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "12px 0" }}>
                          <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
                          <span style={{ fontSize: 13 }}>{t(key("import.replaceEnable"))}</span>
                        </label>
                        {replace ? (
                          <Field
                            label={t(key("import.replaceConfirmLabel"))}
                            hint={`${t(key("import.replaceConfirmHint"))} ${instanceAddress}`}
                          >
                            <Input
                              value={typedAddress}
                              onChange={(e) => setTypedAddress(e.target.value)}
                              placeholder={instanceAddress}
                              autoComplete="off"
                            />
                          </Field>
                        ) : null}
                      </>
                    )}
                  </>
                ) : null}
              </div>
            </>
          ) : null}
        </>
      ) : null}

      {job ? (
        <div style={st.section}>
          <h2 style={st.h2}>
            {running ? t(key("import.running")) : t(key("import.finished"))}
          </h2>
          <Progress label={t(key("import.accounts"))} done={job.accountsDone} total={job.accountsTotal} />
          <Progress label={t(key("import.conversations"))} done={job.channelsDone} total={job.channelsTotal} />
          <Progress label={t(key("import.messages"))} done={job.messagesDone} total={job.messagesTotal} />
          <Progress label={t(key("import.files"))} done={job.filesDone} total={job.filesTotal} />
          {job.error ? <p style={{ ...st.sub, marginTop: 12 }}>{job.error}</p> : null}
          {running ? (
            <Button variant="secondary" onClick={stop} style={{ marginTop: 12 }}>
              {t(key("import.cancel"))}
            </Button>
          ) : (
            <p style={{ ...st.sub, marginTop: 12 }}>{t(key("import.nobodyEmailed"))}</p>
          )}
        </div>
      ) : null}

      <div style={{ marginTop: 32 }}>
        <Button variant="ghost" onClick={onClose}>
          {t(key("common.close"))}
        </Button>
      </div>
    </div>
  );
}

/** One line of progress. Shows nothing rather than a full bar when there is nothing to do. */
function Progress({ label, done, total }: { label: string; done: number; total: number }) {
  if (total === 0) return null;
  const share = Math.min(100, Math.round((done / total) * 100));
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={st.row}>
        <span>{label}</span>
        <span style={st.muted}>
          {done} / {total}
        </span>
      </div>
      <div style={st.bar}>
        <div style={{ ...st.fill, width: `${share}%` }} />
      </div>
    </div>
  );
}
