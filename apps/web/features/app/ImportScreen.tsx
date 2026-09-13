import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { Button, Card, Checkbox, Field, Icon, IconButton, Input, Tag } from "@/components/ds";
import { formatNumber } from "@/lib/i18n/format";
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
 * plan has been read**. It is three steps, named and numbered, because that is what it is: name an
 * archive, read what would happen, then let it run. Nobody should have to guess which of those they
 * are in.
 *
 * What the export could not take is shown in its producer's own words, in full and before the run,
 * because an import that leaves things behind without saying so is the one failure this chain
 * exists to prevent.
 *
 * Only an instance administrator ever reaches this: the routes behind it answer 404 to everyone
 * else, so showing it to anyone else would show them a screen full of errors.
 */

const st: Record<string, CSSProperties> = {
  shell: { flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 },
  top: {
    height: "var(--topbar-height)",
    flex: "none",
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "0 16px",
    margin: 0,
    borderBottom: "1px solid var(--border-subtle)",
  },
  title: {
    margin: 0,
    fontSize: 15,
    fontWeight: 600,
    letterSpacing: "var(--tracking-tight)",
    color: "var(--text-strong)",
  },
  body: { flex: 1, overflow: "auto", minHeight: 0 },
  page: { maxWidth: 760, padding: "24px 28px 56px", margin: "0 auto" },
  intro: { fontSize: 13, color: "var(--text-muted)", lineHeight: 1.55, margin: "0 0 22px" },

  steps: { display: "flex", alignItems: "center", gap: 8, margin: "0 0 24px", flexWrap: "wrap" },
  stepGap: { width: 18, height: 1, background: "var(--border-default)" },

  section: { margin: "28px 0 0" },
  h2: {
    fontSize: 13,
    fontWeight: 600,
    letterSpacing: "var(--tracking-caps)",
    textTransform: "uppercase",
    color: "var(--text-subtle)",
    margin: "0 0 10px",
  },
  note: { fontSize: 12, color: "var(--text-muted)", lineHeight: 1.55, margin: "8px 0 0" },

  // The count grid, straight out of the design-system mockup: numbers big enough to be read at a
  // glance and lined up on their digits, because these are compared, not just seen.
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 18 },
  figure: {
    fontSize: 22,
    fontWeight: 700,
    color: "var(--text-strong)",
    letterSpacing: "var(--tracking-tight)",
    fontVariantNumeric: "tabular-nums",
  },
  figureLabel: { fontSize: 12, color: "var(--text-muted)", marginTop: 2 },

  spaceRow: { display: "flex", alignItems: "center", gap: 10, padding: "10px 0" },
  spaceName: { fontSize: 13, fontWeight: 500, color: "var(--text-strong)" },
  spaceSub: { fontSize: 12, color: "var(--text-muted)", marginTop: 2 },

  row: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    padding: "7px 0",
    fontSize: 13,
    color: "var(--text-body)",
  },
  rowValue: { fontVariantNumeric: "tabular-nums", color: "var(--text-strong)", fontWeight: 500 },
  list: { margin: "6px 0 0", paddingLeft: 18, fontSize: 12.5, lineHeight: 1.6 },

  actions: { display: "flex", alignItems: "center", gap: 10, marginTop: 26, flexWrap: "wrap" },

  bar: { height: 6, borderRadius: 999, background: "var(--surface-sunken)", overflow: "hidden" },
  fill: { height: "100%", background: "var(--terracotta-500)", transition: "width .3s ease" },
};

/** A callout: the same shape for the three things this screen has to say out loud. */
function Callout({
  tone,
  icon,
  children,
}: {
  tone: "info" | "warning" | "danger";
  icon: "info" | "alert-triangle" | "trash-2";
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        padding: 12,
        borderRadius: "var(--radius-md)",
        border: `1px solid var(--status-${tone}-border, var(--border-subtle))`,
        background: `var(--status-${tone}-bg, var(--surface-sunken))`,
        color: `var(--status-${tone}-fg, var(--text-body))`,
      }}
    >
      <Icon name={icon} size={15} style={{ marginTop: 1, flex: "none" }} />
      <div style={{ minWidth: 0, fontSize: 12.5, lineHeight: 1.55 }}>{children}</div>
    </div>
  );
}

/** Where we are, said plainly rather than left to be inferred from what is on screen. */
function Steps({ at }: { at: 1 | 2 | 3 }) {
  const { t } = useTranslation();
  const names = [
    t(key("import.stepArchive")),
    t(key("import.stepPlan")),
    t(key("import.stepRun")),
  ];
  return (
    <div style={st.steps}>
      {names.map((name, i) => {
        const n = (i + 1) as 1 | 2 | 3;
        return (
          <div key={name} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {i > 0 ? <span style={st.stepGap} /> : null}
            <Tag tone={n === at ? "accent" : "neutral"} icon={n < at ? "check" : undefined}>
              {name}
            </Tag>
          </div>
        );
      })}
    </div>
  );
}

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
  const [planError, setPlanError] = useState<string | null>(null);
  const [job, setJob] = useState<ImportJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [replace, setReplace] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [typedAddress, setTypedAddress] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * The first reading of this run, kept so the remaining time is worked out from how fast it is
   * actually going rather than from an average that includes the minute before anything started:
   * the archive is read, checked, and its accounts and conversations written before a single
   * message lands, and folding that silence in would promise an hour on a ten minute job.
   */
  const [pace, setPace] = useState<{ at: number; done: number } | null>(null);
  /** How long is left, in words. Worked out when a reading arrives, never during a render. */
  const [eta, setEta] = useState<string | null>(null);

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
      getImport(job.id)
        .then((next) => {
          setJob(next);
          const now = Date.now();
          const from = pace ?? (next.messagesDone > 0 ? { at: now, done: next.messagesDone } : null);
          if (!pace && from) setPace(from);
          if (!from || next.messagesTotal === 0) return;
          const elapsed = (now - from.at) / 1000;
          const written = next.messagesDone - from.done;
          // Four seconds and one message before saying anything: an estimate drawn from a single
          // reading is a number invented, and a wrong one is worse than none.
          if (elapsed <= 4 || written <= 0) {
            setEta(t(key("import.etaUnknown")));
            return;
          }
          const perSecond = written / elapsed;
          const left = Math.max(0, next.messagesTotal - next.messagesDone) / perSecond;
          const words =
            left < 60
              ? t(key("import.etaSeconds"))
              : t(key("import.etaMinutes"), { count: Math.round(left / 60) });
          setEta(`${words} · ${t(key("import.rate"), { count: Math.round(perSecond) })}`);
        })
        .catch(fail);
    }, POLL_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [job, fail, pace, t]);

  const look = async () => {
    setBusy(true);
    setPlanError(null);
    try {
      setPlan(await planImport(file.trim(), passphrase || undefined));
    } catch (error) {
      setPlan(null);
      // Shown here, under the field that caused it, rather than in a notification that slides
      // away: what is wrong with an archive is often a paragraph, and it is read, not glanced at.
      setPlanError(error instanceof Error ? error.message : String(error));
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
    // Said at the moment of the click. Stopping is not instant: the run leaves at the end of the
    // conversation it is in, which on a large archive is seconds away, and a button that stays
    // pressable meanwhile reads as one that did nothing.
    setStopping(true);
    try {
      setJob(await cancelImport(job.id));
    } catch (error) {
      setStopping(false);
      fail(error);
    }
  };

  const startOver = () => {
    setPace(null);
    setEta(null);
    setStopping(false);
    setJob(null);
    setPlan(null);
    setPlanError(null);
    setReplace(false);
    setTypedAddress("");
  };

  const running = job?.status === "running" || job?.status === "cancelling";

  const dying = plan?.replacingWouldDestroy;
  const step: 1 | 2 | 3 = job ? 3 : plan ? 2 : 1;

  return (
    <div style={st.shell}>
      <div style={st.top}>
        <Icon name="import" size={15} style={{ color: "var(--text-muted)" }} />
        <h1 style={st.title}>{t(key("import.screenTitle"))}</h1>
        {/* Always here, including while a run is going: the run continues without this screen, and
            the sentence saying so was true of a screen that could not be left. */}
        <IconButton
          icon="x"
          label={t(key("import.close"))}
          onClick={onClose}
          style={{ marginLeft: "auto" }}
        />
      </div>

      <div style={st.body}>
        <div style={st.page}>
          <p style={st.intro}>{t(key("import.intro"))}</p>
          <Steps at={step} />

          {/* Step one. A name, never a path: the server reads only its import directory, and an
              administrator is trusted with the instance rather than handed a way to have it open
              any file on the machine. */}
          {step === 1 ? (
            <Card padded>
              <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
                <Field
                  label={t(key("import.fileLabel"))}
                  hint={t(key("import.fileHint"))}
                  htmlFor="import-file"
                >
                  <Input
                    id="import-file"
                    autoFocus
                    value={file}
                    onChange={(e) => setFile(e.target.value)}
                    placeholder="export.tar.gpg"
                    icon="file-archive"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && file.trim() && !busy) void look();
                    }}
                  />
                </Field>
                <Field
                  label={t(key("import.passphraseLabel"))}
                  hint={t(key("import.passphraseHint"))}
                  htmlFor="import-pass"
                >
                  <Input
                    id="import-pass"
                    type="password"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    autoComplete="off"
                  />
                </Field>
              </div>
              <div style={{ marginTop: 16 }}>
                <Button variant="primary" iconLeft="search" onClick={look} loading={busy} disabled={!file.trim()}>
                  {t(key("import.look"))}
                </Button>
              </div>
              {planError ? (
                <div style={{ marginTop: 14 }}>
                  <Callout tone="danger" icon="alert-triangle">
                    <strong style={{ display: "block", marginBottom: 2 }}>
                      {t(key("import.planError"))}
                    </strong>
                    {planError}
                  </Callout>
                </div>
              ) : (
                <p style={st.note}>{t(key("import.emptyHint"))}</p>
              )}
            </Card>
          ) : null}

          {/* Step two: everything that would happen, before any of it does. */}
          {step === 2 && plan ? (
            <>
              <Card variant="sunken" padded>
                <div style={st.grid}>
                  {[
                    [plan.spaces.length, t(key("import.spaces"))],
                    [plan.accounts.total, t(key("import.accounts"))],
                    [plan.messages, t(key("import.messages"))],
                    [plan.files, t(key("import.files"))],
                  ].map(([n, label]) => (
                    <div key={String(label)}>
                      <div style={st.figure}>{formatNumber(Number(n))}</div>
                      <div style={st.figureLabel}>{label}</div>
                    </div>
                  ))}
                </div>
              </Card>

              <div style={st.section}>
                <h2 style={st.h2}>{t(key("import.spaces"))}</h2>
                <Card padded>
                  {plan.spaces.map((space, i) => (
                    <div
                      key={space.name}
                      style={{
                        ...st.spaceRow,
                        borderTop: i > 0 ? "1px solid var(--border-subtle)" : undefined,
                      }}
                    >
                      <Icon name="hash" size={15} style={{ color: "var(--text-subtle)" }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={st.spaceName}>{space.name}</div>
                        {/* Labelled, not two numbers with a dot between them. */}
                        <div style={st.spaceSub}>
                          {space.channels} {t(key("import.channels"))} · {space.directs}{" "}
                          {t(key("import.directs"))}
                        </div>
                      </div>
                      {/* Both keys written out: the audit reads the source for its call sites, and
                          a key assembled at runtime is a key nobody can find again. */}
                      <Tag tone={space.outcome === "created" ? "accent" : "neutral"}>
                        {space.outcome === "created"
                          ? t(key("import.spaceCreated"))
                          : t(key("import.spaceFilled"))}
                      </Tag>
                    </div>
                  ))}
                </Card>
              </div>

              <div style={st.section}>
                <h2 style={st.h2}>{t(key("import.accounts"))}</h2>
                <Card padded>
                  <div style={st.row}>
                    <span>{t(key("import.accountsMatched"))}</span>
                    <span style={st.rowValue}>{plan.accounts.matched}</span>
                  </div>
                  <div style={st.row}>
                    <span>{t(key("import.accountsInvitable"))}</span>
                    <span style={st.rowValue}>{plan.accounts.invitable}</span>
                  </div>
                  {plan.accounts.withoutAddress > 0 ? (
                    <div style={st.row}>
                      <span>{t(key("import.accountsWithoutAddress"))}</span>
                      <span style={st.rowValue}>{plan.accounts.withoutAddress}</span>
                    </div>
                  ) : null}
                  <p style={st.note}>{t(key("import.accountsNote"))}</p>
                </Card>
                {/* Said out loud rather than counted quietly: these people arrive placed and
                    cannot be emailed, so somebody has to give them an address or hand them a
                    link. */}
                {plan.accounts.withoutAddress > 0 ? (
                  <div style={{ marginTop: 10 }}>
                    <Callout tone="warning" icon="alert-triangle">
                      {t(key("import.withoutAddressNote"))}
                    </Callout>
                  </div>
                ) : null}
              </div>

              {/* In the producer's own words, in full. Summarising a declared loss is another way
                  of hiding it. */}
              <div style={st.section}>
                <h2 style={st.h2}>{t(key("import.leftBehind"))}</h2>
                {plan.limits.length > 0 ? (
                  <Callout tone="info" icon="info">
                    {t(key("import.limitsIntro"))}
                    <ul style={st.list}>
                      {plan.limits.map((limit) => (
                        <li key={limit}>{limit}</li>
                      ))}
                    </ul>
                  </Callout>
                ) : (
                  <Callout tone="info" icon="info">
                    {t(key("import.nothingLeftBehind"))}
                  </Callout>
                )}
              </div>

              {plan.warnings.length > 0 ? (
                <div style={st.section}>
                  <h2 style={st.h2}>{t(key("import.warnings"))}</h2>
                  <Callout tone="warning" icon="alert-triangle">
                    <ul style={{ ...st.list, paddingLeft: 16, margin: 0 }}>
                      {plan.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  </Callout>
                </div>
              ) : null}

              {/* The destructive door: closed by default, and never a default. */}
              {dying ? (
                <div style={st.section}>
                  <h2 style={st.h2}>{t(key("import.replaceTitle"))}</h2>
                  <Callout tone="danger" icon="trash-2">
                    {t(key("import.replaceExplain"))}
                    <div style={{ ...st.row, color: "inherit" }}>
                      <span>{t(key("import.replaceWouldDestroy"))}</span>
                      {/* Inherits the callout's colour: a number set in the ordinary ink inside a
                          red panel reads as though it belonged to some other paragraph. */}
                      <span style={{ ...st.rowValue, color: "inherit" }}>
                        {dying.spaces} · {dying.accounts} · {dying.messages}
                      </span>
                    </div>
                    {dying.spaceNames.length > 0 ? (
                      <ul style={st.list}>
                        {dying.spaceNames.map((name) => (
                          <li key={name}>{name}</li>
                        ))}
                      </ul>
                    ) : null}
                    {/* Without a recent backup this is simply destruction, so the door stays
                        shut. */}
                    {!dying.replacementAllowed ? (
                      <p style={{ ...st.note, color: "inherit", marginTop: 10 }}>
                        {t(key("import.replaceNoBackup"))}
                      </p>
                    ) : (
                      <div style={{ marginTop: 12 }}>
                        <Checkbox
                          checked={replace}
                          onChange={(e) => setReplace(e.target.checked)}
                          label={t(key("import.replaceEnable"))}
                        />
                        {replace ? (
                          <div style={{ marginTop: 10, maxWidth: 340 }}>
                            <Field
                              label={t(key("import.replaceConfirmLabel"))}
                              hint={`${t(key("import.replaceConfirmHint"))} ${instanceAddress}`}
                              htmlFor="import-confirm"
                            >
                              <Input
                                id="import-confirm"
                                value={typedAddress}
                                onChange={(e) => setTypedAddress(e.target.value)}
                                placeholder={instanceAddress}
                                autoComplete="off"
                              />
                            </Field>
                          </div>
                        ) : null}
                      </div>
                    )}
                  </Callout>
                </div>
              ) : null}

              <div style={st.actions}>
                <Button
                  variant="primary"
                  iconLeft="play"
                  onClick={begin}
                  loading={busy}
                  disabled={replace && typedAddress.trim() !== instanceAddress}
                >
                  {t(key("import.start"))}
                </Button>
                <Button iconLeft="arrow-left" onClick={startOver} disabled={busy}>
                  {t(key("import.changeArchive"))}
                </Button>
              </div>
              <p style={st.note}>{t(key("import.startNote"))}</p>
            </>
          ) : null}

          {/* Step three. */}
          {step === 3 && job ? (
            <>
              <Card padded>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
                  <Tag
                    tone={
                      job.status === "completed"
                        ? "success"
                        : job.status === "failed"
                          ? "danger"
                          : job.status === "cancelled"
                            ? "warning"
                            : "accent"
                    }
                    icon={job.status === "completed" ? "check" : undefined}
                  >
                    {job.status === "cancelling" || stopping
                      ? t(key("import.stopping"))
                      : running
                        ? t(key("import.running"))
                      : job.status === "completed"
                        ? t(key("import.doneTitle"))
                        : job.status === "cancelled"
                          ? t(key("import.cancelledTitle"))
                          : t(key("import.failedTitle"))}
                  </Tag>
                </div>
                <Progress label={t(key("import.accounts"))} done={job.accountsDone} total={job.accountsTotal} />
                <Progress
                  label={t(key("import.conversations"))}
                  done={job.channelsDone}
                  total={job.channelsTotal}
                />
                <Progress
                  label={t(key("import.messages"))}
                  done={job.messagesDone}
                  total={job.messagesTotal}
                  aside={running ? eta : undefined}
                />
                <Progress label={t(key("import.files"))} done={job.filesDone} total={job.filesTotal} />
              </Card>

              {job.error ? (
                <div style={{ marginTop: 12 }}>
                  <Callout tone="danger" icon="alert-triangle">{job.error}</Callout>
                </div>
              ) : null}

              <div style={st.actions}>
                {running ? (
                  <Button iconLeft="x" onClick={stop} loading={stopping}>
                    {stopping ? t(key("import.stopping")) : t(key("import.cancel"))}
                  </Button>
                ) : (
                  <>
                    <Button variant="primary" onClick={onClose}>
                      {t(key("import.backToSpaces"))}
                    </Button>
                    <Button onClick={startOver}>{t(key("import.importAnother"))}</Button>
                  </>
                )}
              </div>
              <p style={st.note}>
                {running
                  ? t(key("import.runNote"))
                  : job.status === "cancelled"
                    ? t(key("import.cancelledNote"))
                    : t(key("import.nobodyEmailed"))}
              </p>
            </>
          ) : null}

        </div>
      </div>
    </div>
  );
}

/** One line of progress. Shows nothing rather than a full bar when there is nothing to do. */
function Progress({
  label,
  done,
  total,
  aside,
}: {
  label: string;
  done: number;
  total: number;
  /** What else is worth knowing about this line: how fast, and how much longer. */
  aside?: string | null;
}) {
  if (total === 0) return null;
  const share = Math.min(100, Math.round((done / total) * 100));
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={st.row}>
        <span>{label}</span>
        <span style={st.rowValue}>
          {formatNumber(done)} / {formatNumber(total)}
        </span>
      </div>
      {aside ? <div style={{ ...st.note, margin: "2px 0 6px" }}>{aside}</div> : null}
      <div style={st.bar}>
        <div style={{ ...st.fill, width: `${share}%` }} />
      </div>
    </div>
  );
}
