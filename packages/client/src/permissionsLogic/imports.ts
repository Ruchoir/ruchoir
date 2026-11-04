/**
 * What the Members page and the journal say about an import: the banner, who a guest or a group
 * came from, and the figures of the `import.applied` line. Pure; the screens draw it.
 */

export type FigureKind = "administrators" | "guests" | "moderators" | "groups" | "customRoles";

/** One figure of an import, as a banner sentence or a journal chip counts it. */
export type Figure = { kind: FigureKind; count: number };

/** The products an import comes from, spelled as their makers do (never translated). */
const SOURCE_NAMES: Record<string, string> = { slack: "Slack", teams: "Teams", mattermost: "Mattermost", nextcloud: "Nextcloud" };

export function sourceLabel(source: string): string {
  return SOURCE_NAMES[source.toLowerCase()] ?? source;
}

const FIGURE_FIELDS: [FigureKind, string][] = [
  ["administrators", "administrators"],
  ["guests", "guests"],
  ["moderators", "moderators"],
  ["groups", "groups"],
  ["customRoles", "custom_roles"],
];

/** The figures an `import.applied` line carries, in reading order, with every zero left out. */
export function chipsFor(details: Record<string, unknown>): Figure[] {
  return FIGURE_FIELDS.flatMap(([kind, field]) => {
    const count = details[field];
    return typeof count === "number" && count > 0 ? [{ kind, count }] : [];
  });
}

/** The job a journal line points at, for "Ouvrir le rapport"; null when the line carries none. */
export function reportLink(jobId: unknown): string | null {
  return typeof jobId === "string" && jobId.length > 0 ? jobId : null;
}

/** `imported_from` is `<source>:<job id>`: the source, or null for a record nobody imported. */
function sourceOf(importedFrom: string | undefined): string | null {
  if (!importedFrom) return null;
  const source = importedFrom.split(":")[0];
  return source ? sourceLabel(source) : null;
}

/** A guest the import made: the page says so under the end date. */
export function guestMadeByImport(member: { importedFrom?: string }): boolean {
  return sourceOf(member.importedFrom) !== null;
}

/** Where an imported group comes from, said in place of a description it does not have. */
export function importedGroupSource(group: { importedFrom?: string; description?: string }): string | null {
  return group.description ? null : sourceOf(group.importedFrom);
}

/** The line of the journal the banner reads, as the audit list returns it. */
type Line = { at: string; action: string; details: Record<string, unknown> };

export type ImportBanner = {
  source: string;
  jobId: string | null;
  when: { kind: "today" | "yesterday" | "days"; days: number };
  figures: Figure[];
};

const DAY = 86_400_000;

/** The banner covers the last seven days of the journal. */
export const BANNER_DAYS = 7;

/**
 * The newest `import.applied` of the last seven days, for whoever reads the journal (`audit.view`):
 * the banner is read from the journal, so it is as visible as the journal is, no more.
 */
export function importBanner(entries: Line[], now: Date, rights: string[]): ImportBanner | null {
  if (!rights.includes("audit.view")) return null;
  const floor = now.getTime() - BANNER_DAYS * DAY;
  const newest = entries
    .filter((e) => e.action === "import.applied" && Date.parse(e.at) >= floor)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  if (!newest) return null;
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.max(0, Math.round((midnight(now) - midnight(new Date(newest.at))) / DAY));
  const source = typeof newest.details.source === "string" ? sourceLabel(newest.details.source) : "";
  return {
    source,
    jobId: reportLink(newest.details.job_id),
    when: { kind: days === 0 ? "today" : days === 1 ? "yesterday" : "days", days },
    figures: chipsFor(newest.details),
  };
}
