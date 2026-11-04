/**
 * What the import screen says about the people an archive brings: who arrives with which role, which
 * groups are made, who was there already, and what it costs in seats. Pure, so the same words serve
 * the plan (before the run) and the done screen (after it), and so a test can read them.
 *
 * Nothing here reads a translation: each line carries the dictionary keys the component asks for.
 */

/** The people of an archive, as the plan or the finished job states them (one shape for both). */
export type PeopleView = {
  administrators: number;
  guests: number;
  moderators: number;
  groups: number;
  groupNames: string[];
  kept: number;
  keptNames: string[];
  fallbacks: FallbackView[];
  seats: SeatsInput[];
};

/** A role of the source brought down to a fixed one. `space` is known once the run is over. */
export type FallbackView = { space?: string; role: string; fixed: "member" | "admin"; people: number };

/** One licensed space's seats: `usedBefore` taken, `added` coming, `total` sold. */
export type SeatsInput = { space: string; usedBefore: number; added: number; total: number };

export type PeopleKind = "admins" | "guests" | "moderators" | "groups" | "kept" | "fallbacks";

export type PeopleLine = {
  kind: PeopleKind;
  count: number;
  /** The design system's icon for the row. */
  icon: "shield" | "user" | "shield-check" | "users" | "user-check" | "alert-triangle";
  tone: "accent" | "soft" | "success" | "warning";
  /** Plural title: the count goes in as `count`. */
  titleKey: string;
  bodyKey: string;
  /** Administrators only: the sentence about who stays owner, with the name when it is known. */
  ownerKey?: string;
  ownerName?: string;
  /** Chips: the names shown, and how many more there are. */
  names: string[];
  more: number;
  fallbacks: FallbackView[];
};

type PlanPeople = {
  administrators: number;
  guests: number;
  moderators: number;
  groups: number;
  groupNames: string[];
  fallbacks: { role: string; fixed: "member" | "admin"; people: number }[];
  alreadyHere: string[];
  alreadyHereTotal: number;
  seats: { space: string; used: number; incoming: number; total: number; over: boolean }[];
};

type SummaryPeople = {
  administrators: number;
  guests: number;
  moderators: number;
  groups: number;
  groupNames: string[];
  kept: number;
  keptNames: string[];
  fallbacks: { space: string; roleName: string; fixed: "member" | "admin"; people: number }[];
  seats: { space: string; usedBefore: number; added: number; total: number }[];
};

export function viewFromPlan(p: PlanPeople): PeopleView {
  return {
    administrators: p.administrators,
    guests: p.guests,
    moderators: p.moderators,
    groups: p.groups,
    groupNames: p.groupNames,
    kept: p.alreadyHereTotal,
    keptNames: p.alreadyHere,
    fallbacks: p.fallbacks.map((f) => ({ role: f.role, fixed: f.fixed, people: f.people })),
    seats: p.seats.map((s) => ({ space: s.space, usedBefore: s.used, added: s.incoming, total: s.total })),
  };
}

export function viewFromSummary(p: SummaryPeople): PeopleView {
  return {
    administrators: p.administrators,
    guests: p.guests,
    moderators: p.moderators,
    groups: p.groups,
    groupNames: p.groupNames,
    kept: p.kept,
    keptNames: p.keptNames,
    fallbacks: p.fallbacks.map((f) => ({ space: f.space, role: f.roleName, fixed: f.fixed, people: f.people })),
    seats: p.seats,
  };
}

/** How many chips a row shows before "et N autres". */
export const CHIPS_SHOWN = 3;

/**
 * The first `limit` names, and how many more there are. `total` is how many there are in all when
 * the server only sent the first few names.
 */
export function capNames(names: string[], limit: number, total?: number): { shown: string[]; more: number } {
  const shown = names.slice(0, limit);
  return { shown, more: Math.max(0, Math.max(total ?? 0, names.length) - shown.length) };
}

const ADMIN_BODY: Record<string, string> = {
  slack: "import.peopleAdminsSlack",
  teams: "import.peopleAdminsTeams",
  mattermost: "import.peopleAdminsMattermost",
};

/**
 * The rows of the block, in the order of the mockups, and none for a zero.
 *
 * `ownerName` is who stays owner of a space the import creates (the person importing); null when
 * that is not known or not true, which says only that nobody becomes owner.
 */
export function peopleLines(people: PeopleView, source: string, ownerName: string | null): PeopleLine[] {
  const lines: PeopleLine[] = [];
  const base = { names: [], more: 0, fallbacks: [] };
  if (people.administrators > 0) {
    lines.push({
      ...base,
      kind: "admins",
      count: people.administrators,
      icon: "shield",
      tone: "accent",
      titleKey: "import.peopleAdminsTitle",
      bodyKey: ADMIN_BODY[source] ?? "import.peopleAdminsOther",
      ownerKey: ownerName ? "import.peopleOwnerNamed" : "import.peopleOwnerNobody",
      ownerName: ownerName ?? undefined,
    });
  }
  if (people.guests > 0) {
    lines.push({ ...base, kind: "guests", count: people.guests, icon: "user", tone: "soft", titleKey: "space.guests", bodyKey: "import.peopleGuestsBody" });
  }
  if (people.moderators > 0) {
    lines.push({ ...base, kind: "moderators", count: people.moderators, icon: "shield-check", tone: "soft", titleKey: "import.peopleModsTitle", bodyKey: "import.peopleModsBody" });
  }
  if (people.groups > 0) {
    const { shown, more } = capNames(people.groupNames, CHIPS_SHOWN, people.groups);
    lines.push({ ...base, kind: "groups", count: people.groups, icon: "users", tone: "soft", titleKey: "import.peopleGroupsTitle", bodyKey: "import.peopleGroupsBody", names: shown, more });
  }
  if (people.kept > 0) {
    const { shown, more } = capNames(people.keptNames, CHIPS_SHOWN, people.kept);
    lines.push({ ...base, kind: "kept", count: people.kept, icon: "user-check", tone: "success", titleKey: "import.peopleKeptTitle", bodyKey: "import.peopleKeptBody", names: shown, more });
  }
  if (people.fallbacks.length > 0) {
    const fixed = new Set(people.fallbacks.map((f) => f.fixed));
    const titleKey = fixed.size > 1 ? "import.peopleFallbacksMixed" : fixed.has("admin") ? "import.peopleFallbacksAdmin" : "import.peopleFallbacksMember";
    lines.push({ ...base, kind: "fallbacks", count: people.fallbacks.length, icon: "alert-triangle", tone: "warning", titleKey, bodyKey: "import.peopleFallbacksBody", fallbacks: people.fallbacks });
  }
  return lines;
}

export type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** "Rôle « X » ramené à Membre (édition communautaire), 2 personnes", with the space once it is known. */
export function fallbackSentence(f: FallbackView, t: Translate): string {
  const name =
    f.fixed === "admin"
      ? f.space ? "import.fallbackAdminIn" : "import.fallbackAdmin"
      : f.space ? "import.fallbackMemberIn" : "import.fallbackMember";
  return t(name, { role: f.role, space: f.space ?? "", count: f.people });
}

export type SeatsView = {
  space: string;
  tone: "ok" | "over";
  usedBefore: number;
  added: number;
  total: number;
  /** Seats taken once everyone has arrived. */
  usedAfter: number;
  /** Seats still free once everyone has arrived (0 when over). */
  free: number;
  /** Seats free before the import adds anyone: what the sentence of the red state quotes. */
  left: number;
  /** How many places short, 0 when there is room. */
  missing: number;
};

export function seatsView(line: SeatsInput): SeatsView {
  const need = line.usedBefore + line.added;
  const missing = Math.max(0, need - line.total);
  return {
    space: line.space,
    tone: missing > 0 ? "over" : "ok",
    usedBefore: line.usedBefore,
    added: line.added,
    total: line.total,
    usedAfter: need,
    free: Math.max(0, line.total - need),
    left: Math.max(0, line.total - line.usedBefore),
    missing,
  };
}

/** Whether the run cannot start: some filled, licensed space has too few places for who arrives. */
export function startDisabled(people: PeopleView): boolean {
  return people.seats.some((s) => seatsView(s).tone === "over");
}

/** The places short in total, for the bar's footer. */
export function missingPlaces(people: PeopleView): number {
  return people.seats.reduce((sum, s) => sum + seatsView(s).missing, 0);
}

/** A 402 `seats_full` of the start, as the line of the first space that has too few places. */
export function seatsFromRefusal(r: { space?: string; used?: number; incoming?: number; seats: number }): SeatsInput {
  return { space: r.space ?? "", usedBefore: r.used ?? 0, added: r.incoming ?? 0, total: r.seats };
}

/** What the block draws: its rows, the seats of each licensed space, and whether it is red. */
export type BlockView = {
  lines: PeopleLine[];
  seats: SeatsView[];
  /** Some space has too few places: the block is red and Lancer is disabled. */
  over: boolean;
  missing: number;
  /** A custom role was brought down: the block links to the pricing page. */
  pricing: boolean;
};

/** The block for an archive, or null when it says nothing about people (an old archive). */
export function blockView(people: PeopleView | null, source: string, ownerName: string | null): BlockView | null {
  if (!people) return null;
  const lines = peopleLines(people, source, ownerName);
  const seats = people.seats.map(seatsView);
  if (lines.length === 0 && seats.length === 0) return null;
  return { lines, seats, over: seats.some((s) => s.tone === "over"), missing: missingPlaces(people), pricing: people.fallbacks.length > 0 };
}

/**
 * What the done screen shows from the finished job alone, so a screen that finds the job again (no
 * plan in state) says the same as the one that watched it run: the block as the run wrote it, and
 * the producer's limits again, in its own words and in full.
 */
export function doneView(
  job: { source: string; people: SummaryPeople | null; limits: string[] },
  ownerName: string | null,
): { block: BlockView | null; limits: string[] } {
  return {
    block: blockView(job.people ? viewFromSummary(job.people) : null, job.source.toLowerCase(), ownerName),
    limits: job.limits,
  };
}

/** The bar's accessible name: what is needed against what is free when over, else what is used. */
export function seatsBarLabel(seats: SeatsView): { key: string; vars: Record<string, string | number> } {
  if (seats.tone === "over") return { key: "import.seatsOverNeeded", vars: { count: seats.usedAfter, free: seats.left } };
  return { key: "import.seatsUsed", vars: { count: seats.usedAfter, total: String(seats.total) } };
}
