import { useCallback, useEffect, useRef, useState } from "react";
import { type ImportJob, listImports } from "@/lib/data/api";

/**
 * What one item of each pass costs, relative to a message, for a progress bar and nothing else.
 *
 * Counting items made the bar a lie: a hundred files are a sliver of the items and a good part of
 * the time, so it sat at 99 % while they were stored. These are measured, from a run of 25 000
 * messages and 120 files: roughly 4 ms a message, 8 an account, 37 a conversation, 150 a file.
 * Counts shown as figures stay exact; only bars are weighted.
 */
export const PASS_WEIGHT = { accounts: 2, conversations: 10, messages: 1, files: 40 } as const;

/**
 * How far along a run is, or `null` while it is still reading the archive.
 *
 * The run checks the whole archive before it says how much there is, which on a real migration is
 * minutes: until then every total is zero and there is no share to give. `null` means "no figure
 * yet", which a caller shows as waiting rather than as zero.
 */
export function shareOf(job: ImportJob): number | null {
  const passes = [
    [PASS_WEIGHT.accounts, job.accountsDone, job.accountsTotal],
    [PASS_WEIGHT.conversations, job.channelsDone, job.channelsTotal],
    [PASS_WEIGHT.messages, job.messagesDone, job.messagesTotal],
    [PASS_WEIGHT.files, job.filesDone, job.filesTotal],
  ] as const;
  const total = passes.reduce((sum, [weight, , count]) => sum + weight * count, 0);
  if (total === 0) return null;
  const done = passes.reduce((sum, [weight, count, cap]) => sum + weight * Math.min(count, cap), 0);
  return Math.min(100, Math.floor((done / total) * 100));
}

/** Whether a run ended recently enough to still be worth announcing. */
function fresh(job: ImportJob): boolean {
  const ended = job.finishedAt ? Date.parse(job.finishedAt) : NaN;
  return !Number.isNaN(ended) && Date.now() - ended < FRESH_MS;
}

/** A run still going, or one that ended while it was being watched. */
export type ImportTicker = {
  job: ImportJob;
  /** The weighted share, or `null` while the archive is still being read. */
  share: number | null;
  /** Whether it is still going: false means it ended under this session's eyes. */
  running: boolean;
};

/** How often a running import is asked where it has got to. */
const WHILE_RUNNING_MS = 4000;
/** How often the server is asked whether one has started elsewhere. */
const WHILE_IDLE_MS = 60_000;

const RUNS: ImportJob["status"][] = ["pending", "analyzing", "ready", "running", "cancelling"];

/**
 * How recently a run must have ended to still be news.
 *
 * A run watched from here is announced when it ends whatever its length, but a short one can begin
 * and end between two looks - and the shortest are the resumed ones, where nothing is left to do.
 * Ending a few minutes ago is enough to be worth a word; ending this morning is history, and the
 * import screen is where history is read.
 */
const FRESH_MS = 5 * 60 * 1000;

/**
 * The import going on right now, for anywhere outside the import screen.
 *
 * An import outlives the screen that started it, and can be started from another browser
 * altogether. Without this, leaving the screen left the longest and least reversible thing the
 * product does with no trace anywhere in the interface.
 *
 * Only an instance administrator may ask: the route answers 404 to everyone else, so `enabled` is
 * how a caller says whether asking is worth anything. The end of a watched run is kept until
 * `clear` is called, so that the news survives the few seconds between the last item and somebody
 * looking up.
 */
export function useRunningImport(
  enabled: boolean,
): { run: ImportTicker | null; clear: () => void; refresh: () => void } {
  const [run, setRun] = useState<ImportTicker | null>(null);
  /**
   * Bumped to look again at once.
   *
   * Between two runs the server is asked about once a minute, which is often enough for an import
   * somebody started elsewhere. It is far too slow for the one they just started here: the entry
   * sat blank for the best part of a minute, which is exactly the moment it is looked at.
   */
  const [nudge, setNudge] = useState(0);
  /** The run this session has been watching, so its ending is news rather than old history. */
  const watched = useRef<string | null>(null);
  /** The run already acknowledged, which is never announced again. */
  const dismissed = useRef<string | null>(null);

  const refresh = useCallback(() => setNudge((n) => n + 1), []);

  const clear = useCallback(() => {
    watched.current = null;
    setRun((current) => {
      if (!current || current.running) return current;
      dismissed.current = current.job.id;
      return null;
    });
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const look = async () => {
      let next = WHILE_IDLE_MS;
      try {
        const last = (await listImports())[0];
        if (!alive) return;
        if (last && RUNS.includes(last.status)) {
          watched.current = last.id;
          setRun({ job: last, share: shareOf(last), running: true });
          next = WHILE_RUNNING_MS;
        } else if (last && last.id !== dismissed.current && (watched.current === last.id || fresh(last))) {
          // It ended. Held on screen, without polling for it any more, until it is acknowledged.
          setRun({ job: last, share: shareOf(last), running: false });
        } else {
          setRun(null);
        }
      } catch {
        // Offline, or a server that has nothing to say. The next look will tell.
      }
      if (alive) timer = setTimeout(look, next);
    };
    void look();

    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, nudge]);

  // Never a leftover for somebody who cannot ask: an administrator who signs out and back in as
  // anybody else sees nothing rather than the last thing the previous session was watching.
  return { run: enabled ? run : null, clear, refresh };
}
