import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Avatar,
  BrandIcon,
  type BrandName,
  brandFor,
  Button,
  Checkbox,
  Drawer,
  Field,
  Icon,
  IconButton,
  type IconName,
  Input,
  Tag,
} from "@/components/ds";
import { formatBytes, formatDateTime, formatNumber, formatStamp } from "@/lib/i18n/format";
import { key, useTranslation } from "@/lib/i18n";
import {
  cancelImport,
  getImport,
  type DropToken,
  type ImportFile,
  type ImportJob,
  type ImportPlan,
  type ImportedPerson,
  inviteImported,
  type InviteOutcome,
  issueDropToken,
  listImportedPeople,
  listImportFiles,
  listImports,
  type PersonChoice,
  planImport,
  startImport,
} from "@/lib/data/api";
import { PASS_WEIGHT } from "./importRun";
import type { Toast } from "./types";

/**
 * Bringing a workspace over from another product.
 *
 * Four steps, one task each, with the main action always in the same place at the bottom: where
 * the workspace comes from, which archive, what would happen, and the run itself. **Nothing is
 * written until the plan has been read**: that is the whole argument of the feature, and the shape
 * of the screen is how it is made.
 *
 * Detail is there when it is asked for rather than laid out in advance. The people are reviewed in
 * a side panel, the export instructions only appear while there is no archive yet, and replacing
 * the instance sits behind "advanced options". Two things are never folded away: what the export
 * could not take, shown in its producer's own words and in full, because an import that leaves
 * things behind without saying so is the one failure this chain exists to prevent; and the step
 * that is actually needed next.
 *
 * Only an instance administrator ever reaches this: the routes behind it answer 404 to everyone
 * else, so showing it to anyone else would show them a screen full of errors.
 */

type Stage = "source" | "archive" | "plan" | "run";
const STAGES: Stage[] = ["source", "archive", "plan", "run"];

/** The three products a workspace can be brought over from, each named by its own logo. */
const PLATFORMS: BrandName[] = ["Slack", "Mattermost", "Nextcloud"];

/** The one command an administrator pastes, with the instance's address and the token filled in. */
function deliveryCommand(platform: BrandName, drop: DropToken): string {
  const base = drop.baseUrl;
  const t = drop.token;
  switch (platform) {
    case "Nextcloud":
      return `curl -fsSL ${base}/tools/import-nextcloud.sh | bash -s -- \\\n  --token ${t} -- --config /var/www/html/config/config.php --data-dir /var/www/html/data`;
    case "Mattermost":
      return `curl -fsSL ${base}/tools/import-mattermost.sh | bash -s -- \\\n  --token ${t} -- --export <dossier-export-mmctl>`;
    case "Slack":
      return `curl -fsSL ${base}/tools/import-slack.sh | bash -s -- \\\n  --token ${t} -- --export <dossier-export-slack>`;
  }
}

/** How often a running import is asked where it has got to. */
const POLL_MS = 2000;

/** How often the import directory is looked at while an archive is awaited. */
const FILES_POLL_MS = 4000;

/**
 * How many people are drawn at once.
 *
 * A migration brings hundreds, and a row can carry a text field: drawing them all makes a panel
 * nobody scrolls through and a browser that stutters while typing in it. The search narrows, and
 * the line underneath says plainly that there are more.
 */
const PEOPLE_SHOWN = 60;

/** How many spaces are listed before the rest are folded behind a count. */
const SPACES_SHOWN = 5;

type Person = ImportPlan["accounts"]["people"][number];

/** Somebody an invitation can go to, whether the plan or the server named them. */
type Invitee = { sourceId: string; displayName: string; email: string };

/**
 * How recently an import must have ended to be offered when the screen opens.
 *
 * Long enough to cover a migration somebody left running overnight, short enough that last month's
 * import is not the first thing on a screen opened to start another one.
 */
const RECENT_MS = 24 * 60 * 60 * 1000;

export function ImportScreen({
  onClose,
  onNotify,
  instanceAddress,
  openLast = false,
  compact = false,
  instanceAdmin = false,
  onFinished,
}: {
  onClose: () => void;
  onNotify?: (t: Toast) => void;
  /**
   * A run watched from this screen has stopped writing (completed, cancelled or failed). The shell
   * re-reads the account's spaces then: an import creates spaces, and the rail used to keep the list
   * it booted with until the page was reloaded.
   */
  onFinished?: () => void;
  /** The address this instance answers on, which is what a replacement asks to be typed back. */
  instanceAddress: string;
  /**
   * Open on the last import rather than on the first step.
   *
   * Set when the screen was opened from the sidebar's notice that a run has ended: what was clicked
   * was that run, so showing the source step with the run offered in a card would be an extra click
   * for something already asked for.
   */
  openLast?: boolean;
  /** A narrow screen: the surface goes edge to edge, so its inner padding tightens to match. */
  compact?: boolean;
  /**
   * The caller administers the instance. Anybody else imports into spaces of their own only, and
   * the server withholds every address but theirs, so the screen offers neither emptying the
   * instance, nor addresses to fill in, nor invitations to send.
   */
  instanceAdmin?: boolean;
}) {
  const { t } = useTranslation();
  const [stage, setStage] = useState<Stage>("source");
  /**
   * The product being left. Chosen first, and only to guide: the archive carries its own `source`
   * in the manifest, so the importer never trusts this. What it changes is which export
   * instructions are shown, since that is the one step that differs between products.
   */
  const [platform, setPlatform] = useState<BrandName | null>(null);

  // --- the archive -------------------------------------------------------------------------------
  /** The archives on the server, watched while on the archive step: a delivery appears here. */
  const [serverFiles, setServerFiles] = useState<ImportFile[] | null>(null);
  /**
   * What was already there when the step opened. Anything not in it arrived while the screen was
   * watching, which is the delivery the administrator is waiting for, and is marked as such.
   */
  const [firstSeen, setFirstSeen] = useState<Set<string> | null>(null);
  const [file, setFile] = useState("");
  const [passphrase, setPassphrase] = useState("");
  /** The escape hatch: type a name instead of choosing one, for an archive placed by hand. */
  const [typingName, setTypingName] = useState(false);
  const [drop, setDrop] = useState<DropToken | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [manualExport, setManualExport] = useState(false);

  // --- the plan ----------------------------------------------------------------------------------
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * What the administrator changed about the people, keyed by the identifier the archive uses.
   *
   * Only the ones they touched. Everybody else travels as the export spells them, and sending two
   * hundred and fifty unchanged rows back would make a decision out of an absence.
   */
  const [choices, setChoices] = useState<Record<string, PersonChoice>>({});
  const [panel, setPanel] = useState<null | "people" | "invite" | "export">(null);
  const [search, setSearch] = useState("");
  const [only, setOnly] = useState<"all" | "no-address" | "left-out">("all");
  const [editing, setEditing] = useState<string | null>(null);
  const [showAllSpaces, setShowAllSpaces] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [replace, setReplace] = useState(false);
  const [typedAddress, setTypedAddress] = useState("");

  // --- the run -----------------------------------------------------------------------------------
  const [job, setJob] = useState<ImportJob | null>(null);
  const [stopping, setStopping] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * The first reading of each pass, kept so its remaining time is worked out from how fast that
   * pass is actually going.
   *
   * Per pass and not for the run as a whole: the four do quite different work at quite different
   * speeds, and an average over all of them would say nothing true about any. Measured from the
   * pass's own first row rather than from the button, because the archive is read and checked
   * before anything lands and folding that silence in would promise an hour on a ten minute job.
   */
  const [paces, setPaces] = useState<Record<string, { at: number; done: number }>>({});
  /** How long each pass has left, in words. Worked out when a reading arrives, never in a render. */
  const [etas, setEtas] = useState<Record<string, string>>({});
  /** Who is ticked in the invitation panel. Chosen there; the one-click button sends to everyone. */
  const [invitees, setInvitees] = useState<Set<string>>(new Set());
  /**
   * Who the import brought over, read back from the server.
   *
   * The plan is only in hand while the screen that read it stays open, and an import of any size
   * outlives that. These come from the correspondences, so the invitations can still be sent by a
   * screen that has just found the run again.
   */
  const [brought, setBrought] = useState<ImportedPerson[] | null>(null);
  /** The last import, when it ended recently enough to be what the administrator came back for. */
  const [recent, setRecent] = useState<ImportJob | null>(null);
  const [invited, setInvited] = useState<InviteOutcome | null>(null);
  const [inviting, setInviting] = useState(false);

  // --- the bar at the bottom ---------------------------------------------------------------------
  const scroller = useRef<HTMLDivElement | null>(null);
  const column = useRef<HTMLDivElement | null>(null);
  /** Whether content runs on under the bar, which is when its edge casts a shadow. */
  const [under, setUnder] = useState(false);

  // An import runs in the server, not in this screen. Somebody who closed it during an hour-long
  // migration and came back would otherwise face step one, with no way to see where their import
  // had got to - blind, on the longest and least reversible thing this product does.
  // Read once, at mount: whether this opening was a request to see the last run. It cannot change
  // while the screen is open, and the screen must not jump steps under the reader if it did.
  const wanted = useRef(openLast);
  useEffect(() => {
    let alive = true;
    listImports()
      .then((jobs) => {
        if (!alive) return;
        const last = jobs[0];
        if (!last) return;
        if (last.status === "running" || last.status === "cancelling") {
          setJob(last);
          setStage("run");
          return;
        }
        // Finished while nobody was looking. Offered rather than opened: the administrator may
        // well be here to start another one - unless they came from the sidebar saying it had
        // ended, which is a request to see it.
        if (wanted.current) {
          setJob(last);
          setStage("run");
          return;
        }
        const ended = last.finishedAt ? Date.parse(last.finishedAt) : NaN;
        if (!Number.isNaN(ended) && Date.now() - ended < RECENT_MS) setRecent(last);
      })
      .catch(() => {
        // Nothing to find, or nothing to say: the screen starts where it always did.
      });
    return () => {
      alive = false;
    };
  }, []);

  const fail = useCallback(
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      onNotify?.({ tone: "danger", title: message });
    },
    [onNotify],
  );

  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setUnder(el.scrollHeight - el.scrollTop - el.clientHeight > 1);
  }, []);

  // The column changes height as panels open and lists arrive; the shadow follows it.
  useLayoutEffect(() => {
    const el = column.current;
    if (!el) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure, stage]);

  // Each step starts at its top: arriving halfway down a plan because the archive list was long is
  // arriving in the middle of a sentence.
  useLayoutEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [stage]);

  // A running import is asked where it is, rather than told: an import writes for minutes or hours
  // and one frame per two seconds is more than anybody reads.
  useEffect(() => {
    if (!job || (job.status !== "running" && job.status !== "cancelling")) return;
    timer.current = setTimeout(() => {
      getImport(job.id)
        .then((next) => {
          setJob(next);
          const now = Date.now();
          const seen: Record<string, { at: number; done: number }> = { ...paces };
          const words: Record<string, string> = {};
          for (const [name, done, total] of [
            ["accounts", next.accountsDone, next.accountsTotal],
            ["conversations", next.channelsDone, next.channelsTotal],
            ["messages", next.messagesDone, next.messagesTotal],
            ["files", next.filesDone, next.filesTotal],
          ] as const) {
            // A pass that has not started, or has finished, has nothing to say about itself.
            if (total === 0 || done === 0 || done >= total) continue;
            const from = seen[name] ?? { at: now, done };
            seen[name] = from;
            const elapsed = (now - from.at) / 1000;
            const written = done - from.done;
            // Four seconds and one row before saying anything: an estimate drawn from a single
            // reading is a number invented, and a wrong one is worse than none.
            if (elapsed <= 4 || written <= 0) {
              words[name] = t(key("import.etaUnknown"));
              continue;
            }
            const left = Math.max(0, total - done) / (written / elapsed);
            words[name] =
              left < 60
                ? t(key("import.etaSeconds"))
                : t(key("import.etaMinutes"), { count: Math.round(left / 60) });
          }
          setPaces(seen);
          setEtas(words);
        })
        .catch(fail);
    }, POLL_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [job, fail, paces, t]);

  // While on the archive step, the server's import directory is watched: an archive a delivery
  // command drops appears without a refresh, and is chosen for the administrator if nothing was.
  useEffect(() => {
    if (stage !== "archive") return;
    let alive = true;
    const tick = () => {
      listImportFiles()
        .then((files) => {
          if (!alive) return;
          setFirstSeen((seen) => seen ?? new Set(files.map((f) => f.name)));
          setServerFiles(files);
          // Never over a name being typed by hand: that field belongs to the administrator.
          if (!typingName) setFile((current) => current || files[0]?.name || "");
        })
        .catch(() => {});
    };
    tick();
    const id = setInterval(tick, FILES_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [stage, typingName]);

  // The first reading of a job that has stopped, once per job: even a cancelled or failed run may
  // already have created its space.
  const finishedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!job || !["completed", "cancelled", "failed"].includes(job.status)) return;
    if (finishedRef.current === job.id) return;
    finishedRef.current = job.id;
    onFinished?.();
  }, [job, onFinished]);

  // Once it is done, who it brought: the list the invitations are chosen from.
  useEffect(() => {
    if (stage !== "run" || job?.status !== "completed") return;
    let alive = true;
    listImportedPeople(job.id)
      .then((found) => {
        if (alive) setBrought(found);
      })
      .catch(fail);
    return () => {
      alive = false;
    };
  }, [stage, job?.status, job?.id, fail]);

  const generateDrop = async () => {
    setIssuing(true);
    try {
      setDrop(await issueDropToken());
    } catch (error) {
      fail(error);
    } finally {
      setIssuing(false);
    }
  };

  const copyCommand = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // A browser that refuses the clipboard leaves the command on screen to select by hand.
    }
  };

  const choosePlatform = (name: BrandName | null) => {
    setPlatform(name);
    setStage("archive");
  };

  const pickFile = (name: string) => {
    if (name === file) return;
    setFile(name);
    setPassphrase("");
    setPlanError(null);
  };

  const analyse = async () => {
    if (!file.trim() || busy) return;
    setBusy(true);
    setPlanError(null);
    try {
      const next = await planImport(file.trim(), passphrase || undefined);
      setPlan(next);
      setStage("plan");
    } catch (error) {
      setPlan(null);
      // Shown here, next to the field that caused it, rather than in a notification that slides
      // away: what is wrong with an archive is often a sentence, and it is read, not glanced at.
      setPlanError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const begin = async () => {
    setBusy(true);
    try {
      setJob(
        await startImport(
          file.trim(),
          passphrase || undefined,
          replace ? typedAddress : undefined,
          Object.values(choices),
        ),
      );
      // The passphrase is not kept a moment longer than the request that used it.
      setPassphrase("");
      setStage("run");
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

  /** Back to the archive step, keeping which archive it was: a resumed run is the same archive. */
  const backToArchive = () => {
    setPlan(null);
    setPlanError(null);
    setJob(null);
    setPaces({});
    setEtas({});
    setStopping(false);
    setInvited(null);
    setInvitees(new Set());
    setReplace(false);
    setTypedAddress("");
    setAdvanced(false);
    setPanel(null);
    setStage("archive");
  };

  /** A fresh start on another archive: what was decided about these people does not carry over. */
  const importAnother = () => {
    setChoices({});
    setFile("");
    setPassphrase("");
    backToArchive();
  };

  // --- the people ----------------------------------------------------------------------------
  const addressOf = (person: { sourceId: string; email: string }) =>
    choices[person.sourceId]?.email ?? person.email;
  const leftOut = (sourceId: string) => choices[sourceId]?.skip === true;
  const decide = (sourceId: string, patch: Partial<PersonChoice>) =>
    setChoices((was) => ({ ...was, [sourceId]: { ...was[sourceId], sourceId, ...patch } }));

  const people = plan?.accounts.people ?? [];
  const noAddress = people.filter((p) => !leftOut(p.sourceId) && !addressOf(p).trim());
  const setAside = people.filter((p) => leftOut(p.sourceId));
  const alreadyHere = people.filter((p) => p.outcome === "matched" && !leftOut(p.sourceId));
  /** Who can be written to: an address, not left out, and not somebody who is already here. */
  const invitable = people.filter(
    (p) => p.outcome !== "matched" && !leftOut(p.sourceId) && addressOf(p).trim() !== "",
  );
  /**
   * The same question once the import is done, answered by the server.
   *
   * Preferred over the plan wherever both exist: it knows what was actually written, including the
   * addresses given by hand during the review and the invitations already sent.
   */
  const toInvite: Invitee[] = brought
    ? brought.filter((person) => person.email.trim() !== "" && !person.invited)
    : invitable.map((person) => ({
        sourceId: person.sourceId,
        displayName: person.displayName,
        email: addressOf(person),
      }));
  const unaddressed = brought
    ? brought.filter((person) => person.email.trim() === "").length
    : noAddress.length;
  const nameOf = (sourceId: string) =>
    brought?.find((person) => person.sourceId === sourceId)?.displayName ??
    people.find((person) => person.sourceId === sourceId)?.displayName ??
    sourceId;

  const openPeople = (filter: "all" | "no-address") => {
    setOnly(filter);
    setSearch("");
    setEditing(null);
    setPanel("people");
  };

  const openInvitePanel = () => {
    setInvitees(new Set(toInvite.map((p) => p.sourceId)));
    setSearch("");
    setPanel("invite");
  };

  const send = async (sourceIds: string[]) => {
    if (!job || sourceIds.length === 0) return;
    setInviting(true);
    try {
      setInvited(await inviteImported(job.id, sourceIds));
      setPanel(null);
    } catch (error) {
      fail(error);
    } finally {
      setInviting(false);
    }
  };

  const running = job?.status === "running" || job?.status === "cancelling";
  const dying = plan?.replacingWouldDestroy;
  const sourceBrand = brandFor(
    plan ? PLATFORMS.find((p) => p.toLowerCase() === plan.source.toLowerCase()) : platform,
  );
  const sourceName = sourceBrand ?? t(key("import.sourceUnknown"));

  // --- the pieces ------------------------------------------------------------------------------
  const colClass = `wc-imp-col${compact ? " wc-imp-col--compact" : ""}`;

  const footer = (left: ReactNode, right: ReactNode) => (
    <div className={`wc-imp-foot${under ? " wc-imp-foot--over" : ""}${compact ? " wc-imp-foot--compact" : ""}`}>
      <div className="wc-imp-foot__in">
        {left}
        <span className="wc-imp-foot__spacer" />
        {right}
      </div>
    </div>
  );

  const stepper = (
    <ol className="wc-imp-steps" aria-label={t(key("import.stepsLabel"))}>
      {STAGES.map((name, i) => {
        const at = STAGES.indexOf(stage);
        const state = i === at ? "current" : i < at ? "done" : "todo";
        // Written out rather than assembled: the audit reads the source for its call sites.
        const label = [
          t("files.source"),
          t(key("import.fileLabel")),
          t(key("import.stepPlan")),
          t(key("import.stepRun")),
        ][i];
        return (
          <li key={name}>
            {i > 0 ? (
              <span className={`wc-imp-steps__line${i <= at ? " wc-imp-steps__line--done" : ""}`} aria-hidden />
            ) : null}
            <span
              className={`wc-imp-step wc-imp-step--${state}`}
              aria-current={state === "current" ? "step" : undefined}
            >
              <span className="wc-imp-step__dot" aria-hidden>
                {state === "done" ? <Icon name="check" size={12} /> : i + 1}
              </span>
              <span className="wc-imp-step__name">{label}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );

  const exportGuide = (where: BrandName, withWaiting: boolean) => {
    const manual: Record<BrandName, string[]> = {
      Slack: [
        t(key("import.exportSlackStep1")),
        t(key("import.exportSlackStep2")),
        t(key("import.exportSeal")),
      ],
      Mattermost: [
        t(key("import.exportMattermostStep1")),
        t(key("import.exportMattermostStep2")),
        t(key("import.exportSeal")),
      ],
      Nextcloud: [
        t(key("import.exportNextcloudStep1")),
        t(key("import.exportNextcloudStep2")),
        t(key("import.exportNextcloudStep3")),
      ],
    };
    return (
      <>
        <ol className="wc-imp-card wc-imp-timeline">
          <li>
            <span className={`wc-imp-timeline__num${drop ? " wc-imp-timeline__num--done" : ""}`} aria-hidden>
              {drop ? <Icon name="check" size={13} /> : 1}
            </span>
            <div style={{ minWidth: 0 }}>
              <h3>{t(key("import.guideGenerate"))}</h3>
              {drop ? (
                <>
                  <div className="wc-imp-command">
                    <code>{deliveryCommand(where, drop)}</code>
                    <IconButton
                      icon={copied ? "check" : "copy"}
                      label={copied ? t("common.copied") : t(key("import.commandCopy"))}
                      onClick={() => copyCommand(deliveryCommand(where, drop))}
                    />
                  </div>
                  <div className="wc-imp-meta">
                    {t(key("import.deliverExpires"), {
                      count: Math.max(1, Math.round(drop.expiresInSecs / 3600)),
                    })}
                  </div>
                </>
              ) : (
                <>
                  <p>{t(key("import.guideGenerateText"))}</p>
                  <div style={{ marginTop: 12 }}>
                    <Button variant="primary" size="sm" onClick={generateDrop} loading={issuing}>
                      {t(key("import.deliverGenerate"))}
                    </Button>
                  </div>
                </>
              )}
            </div>
          </li>
          <li>
            <span className="wc-imp-timeline__num" aria-hidden>
              2
            </span>
            <div>
              <h3>
                {where === "Nextcloud"
                  ? t(key("import.guideRunNextcloud"))
                  : t(key("import.guideRunRuchoir"))}
              </h3>
              <p>{t(key("import.guideRunText"))}</p>
            </div>
          </li>
          <li>
            <span className="wc-imp-timeline__num" aria-hidden>
              3
            </span>
            <div>
              <h3>{t(key("import.guidePassphrase"))}</h3>
              <p>{t(key("import.guidePassphraseText"))}</p>
            </div>
          </li>
        </ol>
        {withWaiting ? (
          <div className="wc-imp-waiting" role="status">
            <span className="wc-imp-pulse" aria-hidden />
            {t(key("import.waiting"))}
          </div>
        ) : null}
        <div className="wc-imp-manual">
          <button
            type="button"
            className="wc-imp-link"
            aria-expanded={manualExport}
            onClick={() => setManualExport((open) => !open)}
          >
            {manualExport ? t(key("import.manualHide")) : t(key("import.manualShow"))}
          </button>
          {manualExport ? (
            <>
              <ol>
                {manual[where].map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ol>
              <p className="wc-imp-meta">{t(key("import.manualDrop"))}</p>
            </>
          ) : null}
        </div>
      </>
    );
  };

  // --- step 1: where from ------------------------------------------------------------------------
  const sourceStep = (
    <div className={colClass} ref={column}>
      {stepper}
      <h2 className="wc-imp-title">{t(key("import.sourceTitle"))}</h2>
      <p className="wc-imp-lead">{t(key("import.sourceLead"))}</p>
      {recent ? (
        <div className="wc-imp-card" style={{ marginBottom: 20 }}>
          <Check
            tone={recent.status === "completed" ? "success" : recent.status === "cancelled" ? "warning" : "warning"}
            icon={recent.status === "completed" ? "check" : "info"}
            title={
              recent.status === "completed"
                ? t(key("import.doneTitle"))
                : recent.status === "cancelled"
                  ? t(key("import.cancelledTitle"))
                  : t(key("import.failedTitle"))
            }
            text={
              recent.finishedAt
                ? t(key("import.recentWhen"), { when: formatStamp(recent.finishedAt) })
                : undefined
            }
            action={
              <Button
                size="sm"
                onClick={() => {
                  setJob(recent);
                  setRecent(null);
                  setStage("run");
                }}
              >
                {t(key("import.recentOpen"))}
              </Button>
            }
          />
        </div>
      ) : null}
      <div className="wc-imp-platforms">
        {PLATFORMS.map((name) => (
          <button key={name} type="button" className="wc-imp-platform" onClick={() => choosePlatform(name)}>
            <BrandIcon name={name} size={32} />
            <span>
              <span className="wc-imp-platform__name" style={{ display: "block" }}>
                {name}
              </span>
              <span className="wc-imp-platform__desc" style={{ display: "block" }}>
                {name === "Slack"
                  ? t(key("import.platformSlack"))
                  : name === "Mattermost"
                    ? t(key("import.platformMattermost"))
                    : t(key("import.platformNextcloud"))}
              </span>
            </span>
          </button>
        ))}
      </div>
      <p className="wc-imp-meta" style={{ fontSize: "var(--text-xs)", marginTop: 22, color: "var(--text-muted)" }}>
        {t(key("import.skipLead"))}{" "}
        <button type="button" className="wc-imp-link" onClick={() => choosePlatform(null)}>
          {t(key("import.skipAction"))}
        </button>
      </p>
    </div>
  );

  // --- step 2: the archive -----------------------------------------------------------------------
  const noArchiveYet = serverFiles !== null && serverFiles.length === 0 && !typingName;

  const passphraseField = (
    <Field label={t(key("import.passphraseLabel"))} htmlFor="import-pass">
      <Input
        id="import-pass"
        type="password"
        value={passphrase}
        onChange={(e) => {
          setPassphrase(e.target.value);
          setPlanError(null);
        }}
        placeholder={t(key("import.passphrasePlaceholder"))}
        autoComplete="off"
        invalid={planError !== null}
        autoFocus
        onKeyDown={(e) => {
          if (e.key === "Enter") void analyse();
        }}
      />
      {planError ? (
        <div className="wc-imp-error" role="alert">
          <Icon name="circle-alert" size={14} style={{ flex: "none", marginTop: 2 }} />
          <span>{planError}</span>
        </div>
      ) : null}
    </Field>
  );

  const archiveStep = (
    <div className={colClass} ref={column}>
      {stepper}
      {noArchiveYet ? (
        platform ? (
          <>
            <div className="wc-imp-eyebrow">
              <BrandIcon name={platform} size={14} /> {platform}
            </div>
            <h2 className="wc-imp-title">{t(key("import.exportTitle"))}</h2>
            <p className="wc-imp-lead">{t(key("import.exportLead"))}</p>
            {exportGuide(platform, true)}
            <p className="wc-imp-meta" style={{ marginTop: 14 }}>
              <button type="button" className="wc-imp-link wc-imp-link--muted" onClick={() => setTypingName(true)}>
                {t(key("import.pickManual"))}
              </button>
            </p>
          </>
        ) : (
          <>
            <h2 className="wc-imp-title">{t(key("import.noArchiveTitle"))}</h2>
            <p className="wc-imp-lead">{t(key("import.noArchiveLead"))}</p>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <Button variant="primary" onClick={() => setStage("source")}>
                {t(key("import.noArchiveExport"))}
              </Button>
              <Button onClick={() => setTypingName(true)}>{t(key("import.pickManual"))}</Button>
            </div>
          </>
        )
      ) : (
        <>
          <h2 className="wc-imp-title">{t(key("import.pickTitle"))}</h2>
          <p className="wc-imp-lead">{t(key("import.pickLead"))}</p>
          {serverFiles === null ? (
            <p className="wc-imp-meta">{t(key("import.pickWaiting"))}</p>
          ) : (
            <div className="wc-imp-files" role="radiogroup" aria-label={t(key("import.pickTitle"))}>
              {serverFiles.map((f) => {
                const selected = !typingName && file === f.name;
                const fresh = firstSeen !== null && !firstSeen.has(f.name);
                return (
                  <div key={f.name} className={`wc-imp-choice${selected ? " wc-imp-choice--selected" : ""}`}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className="wc-imp-choice__head"
                      onClick={() => {
                        setTypingName(false);
                        pickFile(f.name);
                      }}
                    >
                      <span className="wc-imp-radio" aria-hidden />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span className="wc-imp-choice__name" style={{ display: "block" }}>
                          {f.name}
                        </span>
                        <span className="wc-imp-choice__sub" style={{ display: "block" }}>
                          {formatBytes(f.bytes)}
                          {f.modified ? ` · ${formatStamp(f.modified)}` : ""}
                        </span>
                      </span>
                      {fresh ? <span className="wc-imp-new">{t(key("import.fresh"))}</span> : null}
                    </button>
                    {selected ? <div className="wc-imp-choice__body">{passphraseField}</div> : null}
                  </div>
                );
              })}
              {typingName ? (
                <div className="wc-imp-choice wc-imp-choice--selected" style={{ padding: 16 }}>
                  <Field label={t(key("import.fileLabel"))} hint={t(key("import.fileHint"))} htmlFor="import-file">
                    <Input
                      id="import-file"
                      value={file}
                      onChange={(e) => setFile(e.target.value)}
                      placeholder="export.tar.gpg"
                      icon="file-archive"
                      autoComplete="off"
                    />
                  </Field>
                  <div style={{ marginTop: 14 }}>{passphraseField}</div>
                </div>
              ) : null}
            </div>
          )}
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginTop: 16, fontSize: "var(--text-xs)" }}>
            <button
              type="button"
              className="wc-imp-link"
              onClick={() => (platform ? setPanel("export") : setStage("source"))}
            >
              {t(key("import.exportAgain"))}
            </button>
            {!typingName ? (
              <button
                type="button"
                className="wc-imp-link wc-imp-link--muted"
                onClick={() => {
                  setTypingName(true);
                  setFile("");
                  setPassphrase("");
                  setPlanError(null);
                }}
              >
                {t(key("import.pickManual"))}
              </button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );

  // --- step 3: what would happen -----------------------------------------------------------------
  const planStep = plan ? (
    <div className={colClass} ref={column}>
      {stepper}
      <h2 className="wc-imp-title">{t(key("import.planTitle"))}</h2>
      <p className="wc-imp-lead" style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 16, fontSize: "var(--text-xs)" }}>
        {sourceBrand ? <BrandIcon name={sourceBrand} size={13} /> : null}
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--text-body)", overflowWrap: "anywhere" }}>
          {file}
        </span>
        <span>· {t(key("import.planNothingYet"))}</span>
      </p>

      <div className="wc-imp-stats">
        {(
          [
            [plan.spaces.length, t(key("import.spaces"))],
            [plan.accounts.total, t("gsearch.people")],
            [plan.messages, t(key("import.messages"))],
            [plan.files, t(key("import.files"))],
          ] as const
        ).map(([value, label]) => (
          <div key={label} className="wc-imp-stat">
            <div className="wc-imp-stat__value">{formatNumber(value)}</div>
            <div className="wc-imp-stat__label">{label}</div>
          </div>
        ))}
      </div>

      <div className="wc-imp-card">
        {!instanceAdmin ? (
          // In place of the missing-address warning, which would ask for something the server will
          // not accept from this caller.
          <Check tone="info" icon="info" title={t(key("import.scopedTitle"))} text={t(key("import.scopedText"))} />
        ) : people.length > 0 ? (
          noAddress.length > 0 ? (
            <Check
              tone="warning"
              icon="alert-triangle"
              title={t(key("import.checkNoAddress"), { count: noAddress.length })}
              text={t(key("import.checkNoAddressText"))}
              action={
                <Button size="sm" onClick={() => openPeople("no-address")}>
                  {t(key("import.checkComplete"))}
                </Button>
              }
            />
          ) : (
            <Check tone="success" icon="check" title={t(key("import.checkAllAddressed"))} />
          )
        ) : null}
        {/* In the producer's own words, in full. Summarising a declared loss is another way of
            hiding it, so this one is never folded away. */}
        <Check
          tone="info"
          icon="info"
          title={
            plan.limits.length > 0 ? (
              <>
                {t(key("import.limitsTitle"), { source: sourceName })}{" "}
                <span className="wc-imp-check__aside">· {t(key("import.limitsAside"))}</span>
              </>
            ) : (
              t(key("import.nothingLeftBehind"))
            )
          }
        >
          {plan.limits.length > 0 ? (
            <ul>
              {plan.limits.map((limit) => (
                <li key={limit}>{limit}</li>
              ))}
            </ul>
          ) : null}
          {/* What the checker noticed about this archive: said here, next to what the producer
              declared, rather than as a heading of its own for what is usually one line. */}
          {plan.warnings.map((warning) => (
            <div key={warning} className="wc-imp-check__warning">
              <Icon name="alert-triangle" size={13} style={{ flex: "none", marginTop: 3 }} />
              <span>
                <span className="wc-imp-visually-hidden">{t(key("import.warnings"))}</span>{" "}
                {warning}
              </span>
            </div>
          ))}
        </Check>
      </div>

      <div className="wc-imp-card wc-imp-content">
        <div className="wc-imp-content__half">
          <h3 className="wc-imp-h3">{t(key("import.spaces"))}</h3>
          {(showAllSpaces ? plan.spaces : plan.spaces.slice(0, SPACES_SHOWN)).map((space) => (
            <div key={space.name}>
              <div
                className="wc-imp-space"
                title={`${t(key("import.spaceChannels"), { count: space.channels })} · ${t(key("import.spaceDirects"), { count: space.directs })}`}
              >
                <span className="wc-imp-space__name">{space.name}</span>
                <span className="wc-imp-space__count">
                  {t(key("import.spaceChannels"), { count: space.channels })}
                </span>
                {/* Both keys written out: a key assembled at runtime is a key nobody can find again. */}
                <Tag tone={space.outcome === "created" ? "accent" : "neutral"}>
                  {space.outcome === "created" ? t(key("import.spaceCreated")) : t(key("import.spaceFilled"))}
                </Tag>
              </div>
              {/* A merge, said before it happens: these conversations are not created beside the
                  ones already here, they are the ones already here. Nobody should discover that
                  their #general grew a year of somebody else's history without having read it. */}
              {space.channelsFilled > 0 ? (
                <p className="wc-imp-space__note">
                  {t(key("import.spaceChannelsFilled"), { count: space.channelsFilled })}
                </p>
              ) : null}
            </div>
          ))}
          {plan.spaces.length > SPACES_SHOWN && !showAllSpaces ? (
            <button type="button" className="wc-imp-link" style={{ fontSize: "var(--text-xs)", marginTop: 6 }} onClick={() => setShowAllSpaces(true)}>
              {t(key("import.spacesMore"), { count: plan.spaces.length - SPACES_SHOWN })}
            </button>
          ) : null}
        </div>
        <div className="wc-imp-content__half">
          <h3 className="wc-imp-h3">{t("gsearch.people")}</h3>
          <ul className="wc-imp-figures" style={{ listStyle: "none", padding: 0 }}>
            <li>
              <b>{formatNumber(alreadyHere.length)}</b> {t(key("import.figureHere"))}
            </li>
            <li>
              <b>{formatNumber(invitable.length)}</b> {t(key("import.figureInvitable"))}
            </li>
            {noAddress.length > 0 ? (
              <li className="wc-imp-figures--warning">
                <b>{formatNumber(noAddress.length)}</b> {t(key("import.figureNoAddress"))}
              </li>
            ) : null}
            {setAside.length > 0 ? (
              <li>
                <b>{formatNumber(setAside.length)}</b> {t(key("import.figureLeftOut"))}
              </li>
            ) : null}
          </ul>
          {people.length > 0 ? (
            <button type="button" className="wc-imp-link" style={{ fontSize: "var(--text-xs)", marginTop: 10 }} onClick={() => openPeople("all")}>
              {t(key("import.reviewPeople"), { count: people.length })}
            </button>
          ) : null}
        </div>
      </div>

      {/* The destructive door: folded away, closed by default, and never a default. For the
          administrators of the instance only: nobody else can empty it, so nobody else sees it. */}
      {dying && instanceAdmin ? (
        <div className="wc-imp-advanced">
          <button
            type="button"
            className="wc-imp-disclosure"
            aria-expanded={advanced}
            onClick={() => setAdvanced((open) => !open)}
          >
            <Icon name={advanced ? "chevron-down" : "chevron-right"} size={14} />
            {t(key("import.advanced"))}
          </button>
          {advanced ? (
            <div className="wc-imp-danger">
              <h3>{t(key("import.replaceTitle"))}</h3>
              <p>
                {t(key("import.replaceExplain"))}{" "}
                {t(key("import.replaceWouldDestroy"), {
                  spaces: formatNumber(dying.spaces),
                  accounts: formatNumber(dying.accounts),
                  messages: formatNumber(dying.messages),
                })}
                {dying.spaceNames.length > 0 ? ` (${dying.spaceNames.join(", ")})` : ""}
              </p>
              {/* Without a recent backup this is simply destruction, so the door stays shut. */}
              {!dying.replacementAllowed ? (
                <p style={{ marginTop: 8, fontWeight: 500 }}>{t(key("import.replaceNoBackup"))}</p>
              ) : (
                <>
                  {dying.lastBackup ? (
                    <p style={{ marginTop: 6, opacity: 0.85 }}>
                      {t(key("import.replaceLastBackup"), { when: formatDateTime(dying.lastBackup) })}
                    </p>
                  ) : null}
                  <div style={{ marginTop: 12 }}>
                    <Checkbox
                      checked={replace}
                      onChange={(e) => {
                        setReplace(e.target.checked);
                        if (!e.target.checked) setTypedAddress("");
                      }}
                      label={t(key("import.replaceEnable"))}
                    />
                  </div>
                  {replace ? (
                    <div style={{ marginTop: 12, maxWidth: 340 }}>
                      <Field
                        label={t(key("import.replaceConfirmLabel"), { address: instanceAddress })}
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
                </>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  ) : null;

  // --- step 4: the run -----------------------------------------------------------------------------
  /**
   * The run reads and checks the whole archive before it says how much there is, which on a real
   * migration is minutes. Until then the job's totals are all zero, and the screen said so: an empty
   * bar, no passes, and "finishing" - the one word that was certainly false. The plan already knows
   * the counts, so they stand in until the run gives its own.
   */
  const preparing =
    running &&
    job !== null &&
    job.accountsTotal + job.channelsTotal + job.messagesTotal + job.filesTotal === 0;
  const planned = {
    accounts: plan?.accounts.total ?? 0,
    conversations: plan?.spaces.reduce((sum, space) => sum + space.channels + space.directs, 0) ?? 0,
    messages: plan?.messages ?? 0,
    files: plan?.files ?? 0,
  };
  const passes = job
    ? ([
        ["accounts", t(key("import.accounts")), job.accountsDone, preparing ? planned.accounts : job.accountsTotal],
        ["conversations", t(key("import.conversations")), job.channelsDone, preparing ? planned.conversations : job.channelsTotal],
        ["messages", t(key("import.messages")), job.messagesDone, preparing ? planned.messages : job.messagesTotal],
        ["files", t(key("import.files")), job.filesDone, preparing ? planned.files : job.filesTotal],
      ] as const).filter(([, , , total]) => total > 0)
    : [];
  const current = preparing ? undefined : passes.find(([, , done, total]) => done < total);
  const weighed = (which: "done" | "total") =>
    passes.reduce(
      (sum, [name, , done, total]) => sum + PASS_WEIGHT[name] * (which === "done" ? Math.min(done, total) : total),
      0,
    );
  const share = preparing || weighed("total") === 0 ? 0 : Math.min(100, Math.floor((weighed("done") / weighed("total")) * 100));

  const runStep = job ? (
    <div className={colClass} ref={column}>
      {stepper}
      {running ? (
        <>
          <h2 className="wc-imp-title">
            {job.status === "cancelling" || stopping ? t(key("import.stopping")) : t(key("import.running"))}
          </h2>
          <p className="wc-imp-lead" style={{ marginBottom: 0 }} aria-live="polite">
            {preparing
              ? t(key("import.preparing"))
              : current
                ? etas[current[0]]
                  ? `${current[1]} · ${etas[current[0]]}`
                  : current[1]
                : t(key("import.finishing"))}
          </p>
          <div
            className={`wc-imp-bar${preparing ? " wc-imp-bar--waiting" : ""}`}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={preparing ? undefined : share}
            aria-label={t(key("import.running"))}
          >
            <span style={{ width: `${share}%` }} />
          </div>
          <div className="wc-imp-bar__meta">
            <span>{preparing ? "\u00a0" : t(key("import.percent"), { value: share })}</span>
          </div>
          <ul className="wc-imp-phases">
            {passes.map(([name, label, done, total]) => {
              const state = done >= total ? "done" : current?.[0] === name ? "current" : "todo";
              return (
                <li key={name} className={`wc-imp-phase wc-imp-phase--${state}`}>
                  <span className="wc-imp-phase__dot" aria-hidden>
                    {state === "done" ? <Icon name="check" size={12} /> : null}
                  </span>
                  <span className="wc-imp-phase__name">{label}</span>
                  <span className="wc-imp-phase__value">
                    {state === "current" ? `${formatNumber(done)} / ${formatNumber(total)}` : formatNumber(total)}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      ) : job.status === "completed" ? (
        <>
          <div className="wc-imp-mark wc-imp-mark--success" aria-hidden>
            <Icon name="party-popper" size={22} />
          </div>
          <h2 className="wc-imp-title">{t(key("import.doneTitle"))}</h2>
          <p className="wc-imp-lead">
            {plan
              ? t(key("import.doneLead"), {
                  messages: formatNumber(job.messagesDone),
                  files: formatNumber(job.filesDone),
                  count: plan.spaces.length,
                })
              : t(key("import.doneLeadShort"), {
                  messages: formatNumber(job.messagesDone),
                  files: formatNumber(job.filesDone),
                })}
          </p>
          {/* Once it is done, and only then, the question of who hears about it. Nothing left during
              the import: ten thousand accounts arriving is not ten thousand emails leaving, and
              somebody has to say who. */}
          {/* The administrators' alone: a personal import brought nobody with an address. */}
          {instanceAdmin ? (
            <div className="wc-imp-card">
              {invited ? (
                <Check
                  tone="success"
                  icon="check"
                  title={t(key("import.invitationsSent"), { count: invited.sent })}
                  text={unaddressed > 0 ? t(key("import.invitationsNoAddress"), { count: unaddressed }) : undefined}
                >
                  {invited.skipped.length > 0 ? (
                    <>
                      <div className="wc-imp-check__text" style={{ marginTop: 6 }}>
                        {t(key("import.invitationsSkipped"))}
                      </div>
                      <ul>
                        {invited.skipped.map((one) => (
                          <li key={one.sourceId}>
                            {nameOf(one.sourceId)} : {one.reason}
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                </Check>
              ) : brought === null ? (
                <Check tone="info" icon="info" title={t(key("import.invitationsLoading"))} />
              ) : toInvite.length === 0 ? (
                <Check tone="info" icon="info" title={t(key("import.invitationsNobody"))} />
              ) : (
                <Check
                  tone="accent"
                  icon="send"
                  title={t(key("import.inviteTitle"))}
                  text={t(key("import.inviteLead"), { count: toInvite.length })}
                >
                  <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
                    <Button
                      variant="primary"
                      size="sm"
                      loading={inviting}
                      onClick={() => void send(toInvite.map((p) => p.sourceId))}
                    >
                      {t(key("import.inviteAll"), { count: toInvite.length })}
                    </Button>
                    <Button size="sm" onClick={openInvitePanel} disabled={inviting}>
                      {t(key("import.inviteChoose"))}
                    </Button>
                  </div>
                </Check>
              )}
            </div>
          ) : null}
        </>
      ) : (
        <>
          <div
            className={`wc-imp-mark wc-imp-mark--${job.status === "cancelled" ? "warning" : "danger"}`}
            aria-hidden
          >
            <Icon name={job.status === "cancelled" ? "info" : "circle-alert"} size={22} />
          </div>
          <h2 className="wc-imp-title">
            {job.status === "cancelled" ? t(key("import.cancelledTitle")) : t(key("import.failedTitle"))}
          </h2>
          <p className="wc-imp-lead">{t(key("import.cancelledNote"))}</p>
          {job.error ? <div className="wc-imp-notice">{job.error}</div> : null}
        </>
      )}
    </div>
  ) : null;

  // --- the panels ----------------------------------------------------------------------------------
  const inviteMode = panel === "invite";
  const panelPeople: (Person | Invitee)[] = (inviteMode ? toInvite : people).filter((person) => {
    if (!inviteMode) {
      if (only === "no-address" && (leftOut(person.sourceId) || addressOf(person).trim())) return false;
      if (only === "left-out" && !leftOut(person.sourceId)) return false;
    }
    const needle = search.trim().toLowerCase();
    if (!needle) return true;
    return (
      person.displayName.toLowerCase().includes(needle) ||
      addressOf(person).toLowerCase().includes(needle)
    );
  });

  const personRow = (person: Person | Invitee) => {
    const address = addressOf(person);
    const out = leftOut(person.sourceId);
    if (inviteMode) {
      return (
        <div key={person.sourceId} className="wc-imp-person">
          <Checkbox
            checked={invitees.has(person.sourceId)}
            aria-label={person.displayName}
            onChange={(e) =>
              setInvitees((was) => {
                const next = new Set(was);
                if (e.target.checked) next.add(person.sourceId);
                else next.delete(person.sourceId);
                return next;
              })
            }
          />
          <Avatar name={person.displayName} size={32} />
          <div className="wc-imp-person__who">
            <div className="wc-imp-person__name">{person.displayName}</div>
            <div className="wc-imp-person__email">{address}</div>
          </div>
        </div>
      );
    }
    // A missing address is asked for on the spot; an existing one is text until somebody wants to
    // change it. Forty-eight open fields is a form, and nobody reads a form.
    const asking = instanceAdmin && !out && (editing === person.sourceId || !address.trim());
    return (
      <div key={person.sourceId} className={`wc-imp-person${out ? " wc-imp-person--out" : ""}`}>
        <Avatar name={person.displayName} size={32} />
        <div className="wc-imp-person__who">
          <div className="wc-imp-person__name">
            {person.displayName}
            {"outcome" in person && person.outcome === "matched" ? (
              <span className="wc-imp-person__tag"> · {t(key("import.figureHere"))}</span>
            ) : null}
          </div>
          {asking ? (
            <Input
              size="sm"
              value={address}
              onChange={(e) => decide(person.sourceId, { email: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === "Escape") setEditing(null);
              }}
              placeholder={t(key("import.peopleEmailPlaceholder"))}
              aria-label={t(key("import.personAddress"), { name: person.displayName })}
              autoFocus={editing === person.sourceId}
              autoComplete="off"
            />
          ) : (
            <div className={`wc-imp-person__email${address.trim() ? "" : " wc-imp-person__email--missing"}`}>
              {out ? t(key("import.personLeftOut")) : address}
            </div>
          )}
        </div>
        {out ? (
          <Button size="sm" variant="ghost" iconLeft="undo-2" onClick={() => decide(person.sourceId, { skip: false })}>
            {t(key("import.peoplePutBack"))}
          </Button>
        ) : (
          <>
            {instanceAdmin && address.trim() && !asking ? (
              <IconButton
                icon="square-pen"
                size="sm"
                label={t(key("import.personEdit"), { name: person.displayName })}
                onClick={() => setEditing(person.sourceId)}
              />
            ) : null}
            <IconButton
              icon="user-minus"
              size="sm"
              label={t(key("import.personLeaveOut"), { name: person.displayName })}
              onClick={() => decide(person.sourceId, { skip: true })}
            />
          </>
        )}
      </div>
    );
  };

  const peoplePanel = (
    <div className="wc-imp-panel">
      <div className="wc-imp-panel__head">
        <h2>{inviteMode ? t(key("import.invitePanelTitle")) : t(key("import.peopleTitle"))}</h2>
        <IconButton icon="x" label={t("common.close")} onClick={() => setPanel(null)} />
      </div>
      <p className="wc-imp-panel__intro">
        {inviteMode ? t(key("import.invitePanelIntro")) : t(key("import.peopleIntro"))}
      </p>
      <div className="wc-imp-panel__tools">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t(key("import.peopleSearch"))}
          aria-label={t(key("import.peopleSearch"))}
          icon="search"
        />
        {inviteMode ? (
          <div style={{ display: "flex", gap: 8 }}>
            <Button size="sm" variant="ghost" onClick={() => setInvitees(new Set(toInvite.map((p) => p.sourceId)))}>
              {t(key("import.invitationsSelectAll"))}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setInvitees(new Set())}>
              {t(key("import.invitationsSelectNone"))}
            </Button>
          </div>
        ) : (
          <div className="wc-imp-segmented" role="group" aria-label={t(key("import.peopleFilter"))}>
            {/* Written out rather than built from the value: a key assembled at runtime is a key
                nobody can find again. */}
            <button type="button" aria-pressed={only === "all"} onClick={() => setOnly("all")}>
              {t(key("import.peopleAll"))}
              <span className="wc-imp-segmented__count">{formatNumber(people.length)}</span>
            </button>
            <button type="button" aria-pressed={only === "no-address"} onClick={() => setOnly("no-address")}>
              {t(key("import.peopleNoAddress"))}
              <span className="wc-imp-segmented__count">{formatNumber(noAddress.length)}</span>
            </button>
            <button type="button" aria-pressed={only === "left-out"} onClick={() => setOnly("left-out")}>
              {t(key("import.peopleLeftOut"))}
              <span className="wc-imp-segmented__count">{formatNumber(setAside.length)}</span>
            </button>
          </div>
        )}
      </div>
      <div className="wc-imp-panel__list">
        {panelPeople.length === 0 ? <p className="wc-imp-more">{t("common.nobodyMatches")}</p> : null}
        {panelPeople.slice(0, PEOPLE_SHOWN).map(personRow)}
        {panelPeople.length > PEOPLE_SHOWN ? (
          <p className="wc-imp-more">
            {t(key("import.peopleShowingSome"), { count: PEOPLE_SHOWN, total: panelPeople.length })}
          </p>
        ) : null}
      </div>
      <div className="wc-imp-panel__foot">
        {inviteMode ? (
          <>
            <span>{t(key("import.inviteSelected"), { count: invitees.size })}</span>
            <Button
              variant="primary"
              iconLeft="send"
              loading={inviting}
              disabled={invitees.size === 0}
              onClick={() => void send([...invitees])}
            >
              {t(key("import.invitationsSend"), { count: invitees.size })}
            </Button>
          </>
        ) : (
          <>
            <span>{t(key("import.peopleSkipNote"))}</span>
            <Button variant="primary" onClick={() => setPanel(null)}>
              {t(key("import.done"))}
            </Button>
          </>
        )}
      </div>
    </div>
  );

  const exportPanel = platform ? (
    <div className="wc-imp-panel">
      <div className="wc-imp-panel__head">
        <h2>{t(key("import.exportAgain"))}</h2>
        <IconButton icon="x" label={t("common.close")} onClick={() => setPanel(null)} />
      </div>
      <div style={{ padding: "0 20px 20px", overflow: "auto" }}>{exportGuide(platform, false)}</div>
    </div>
  ) : null;

  // --- the bars at the bottom ----------------------------------------------------------------------
  const back = (label: string, onClick: () => void, disabled = false) => (
    <Button variant="ghost" iconLeft="arrow-left" onClick={onClick} disabled={disabled}>
      {label}
    </Button>
  );

  let bottom: ReactNode = null;
  if (stage === "archive") {
    bottom = footer(
      back(t("common.back"), () => {
        setTypingName(false);
        setStage("source");
      }),
      noArchiveYet ? null : (
        <Button variant="primary" iconRight="arrow-right" onClick={analyse} loading={busy} disabled={!file.trim()}>
          {busy ? t(key("import.analysing")) : t(key("import.analyse"))}
        </Button>
      ),
    );
  } else if (stage === "plan") {
    bottom = footer(
      back(t(key("import.changeArchive")), backToArchive, busy),
      replace ? (
        <Button variant="danger" onClick={begin} loading={busy} disabled={typedAddress.trim() !== instanceAddress}>
          {t(key("import.startReplacing"))}
        </Button>
      ) : (
        <Button variant="primary" onClick={begin} loading={busy}>
          {t(key("import.start"))}
        </Button>
      ),
    );
  } else if (stage === "run" && job) {
    bottom = running
      ? footer(
          <span className="wc-imp-foot__note">{t(key("import.runNote"))}</span>,
          <Button onClick={stop} loading={stopping} disabled={job.status === "cancelling"}>
            {t(key("import.cancel"))}
          </Button>,
        )
      : job.status === "completed"
        ? footer(
            <Button variant="ghost" onClick={importAnother}>
              {t(key("import.importAnother"))}
            </Button>,
            <Button variant="primary" iconRight="arrow-right" onClick={onClose}>
              {t(key("import.backToSpaces"))}
            </Button>,
          )
        : footer(
            <Button variant="ghost" onClick={importAnother}>
              {t(key("import.otherArchive"))}
            </Button>,
            <Button variant="primary" onClick={backToArchive}>
              {t(key("import.resume"))}
            </Button>,
          );
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
      <div
        style={{
          height: "var(--topbar-height)",
          flex: "none",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0 16px",
          borderBottom: "1px solid var(--border-subtle)",
        }}
      >
        <Icon name="import" size={15} style={{ color: "var(--text-muted)" }} />
        <h1 id="import-title" style={{ margin: 0, fontSize: "var(--text-md)", fontWeight: 600, letterSpacing: "var(--tracking-tight)", color: "var(--text-strong)" }}>
          {t(key("import.screenTitle"))}
        </h1>
        {/* Always here, including while a run is going: the run continues without this screen. */}
        <IconButton icon="x" label={t(key("import.close"))} onClick={onClose} style={{ marginLeft: "auto" }} />
      </div>

      <div ref={scroller} onScroll={measure} style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        {stage === "source" ? sourceStep : null}
        {stage === "archive" ? archiveStep : null}
        {stage === "plan" ? planStep : null}
        {stage === "run" ? runStep : null}
      </div>
      {bottom}

      <Drawer
        open={panel !== null}
        onClose={() => setPanel(null)}
        side="right"
        width={520}
        label={
          panel === "export"
            ? t(key("import.exportAgain"))
            : inviteMode
              ? t(key("import.invitePanelTitle"))
              : t(key("import.peopleTitle"))
        }
      >
        {panel === "export" ? exportPanel : panel ? peoplePanel : null}
      </Drawer>
    </div>
  );
}

/** One line of the plan's checklist: what it is about, said once, with its action if it has one. */
function Check({
  tone,
  icon,
  title,
  text,
  action,
  children,
}: {
  tone: "warning" | "info" | "success" | "accent";
  icon: IconName;
  title: ReactNode;
  text?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="wc-imp-check">
      <span className={`wc-imp-check__icon wc-imp-check__icon--${tone}`} aria-hidden>
        <Icon name={icon} size={14} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="wc-imp-check__title">{title}</div>
        {text ? <div className="wc-imp-check__text">{text}</div> : null}
        {children}
      </div>
      {action ? <div style={{ alignSelf: "center", flex: "none" }}>{action}</div> : null}
    </div>
  );
}
