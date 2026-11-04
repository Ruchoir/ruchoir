/**
 * What the guest screens decide, without drawing anything: how an end date is chosen, how far away
 * it is, and how it is worded. A guest's access ends at the end of a day in the zone of whoever sets
 * it (the API reads a bare date that way too), so the instants sent from here are computed in that
 * zone rather than in the server's.
 */

/** One of the ready-made durations, no end at all, or a date picked by hand (`YYYY-MM-DD`). */
export type EndChoice = "none" | "week" | "month" | "quarter" | { date: string };

/** Parts are read in a fixed numeric format, never shown: the locale only has to be one that writes digits the same way everywhere. */
const PARTS_LOCALE = "en-CA";
const DAY_MS = 86_400_000;
/** Soon: the warning tag and the Prolong button appear at this many days or fewer. */
export const SOON_DAYS = 7;
/** An end date further than this many years ahead is a typo (the API refuses it too). */
export const MAX_YEARS = 5;

type Wall = { y: number; m: number; d: number };

/** The calendar day an instant falls on in `zone`. */
function dayIn(at: Date, zone: string): Wall {
  const parts = new Intl.DateTimeFormat(PARTS_LOCALE, { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

/** The offset of `zone` from UTC at `at`, in milliseconds. */
function offsetAt(at: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat(PARTS_LOCALE, {
    timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - Math.floor(at.getTime() / 1000) * 1000;
}

/** 23:59:59 on `day` as it reads in `zone`, as an instant. */
function endOfDay({ y, m, d }: Wall, zone: string): Date {
  const wall = Date.UTC(y, m - 1, d, 23, 59, 59);
  let guess = wall;
  // Two passes settle a day on which the offset itself changes.
  for (let i = 0; i < 2; i += 1) guess = wall - offsetAt(new Date(guess), zone);
  return new Date(guess);
}

function addDays({ y, m, d }: Wall, days: number): Wall {
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return { y: next.getUTCFullYear(), m: next.getUTCMonth() + 1, d: next.getUTCDate() };
}

/** Calendar months ahead, landing on the last day of a shorter month (31 January + 1 month). */
function addMonths({ y, m, d }: Wall, months: number): Wall {
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return { y: first.getUTCFullYear(), m: first.getUTCMonth() + 1, d: Math.min(d, last) };
}

function parseDay(text: string): Wall | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const wall = { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
  const check = new Date(Date.UTC(wall.y, wall.m - 1, wall.d));
  return check.getUTCFullYear() === wall.y && check.getUTCMonth() === wall.m - 1 && check.getUTCDate() === wall.d ? wall : null;
}

const key = ({ y, m, d }: Wall) => y * 10_000 + m * 100 + d;

/**
 * The instant to send for a choice (RFC 3339, the end of that day in `zone`), or `null` for no end.
 * A duration counts from `base` (the current end) when that still lies ahead, from `now` otherwise.
 */
export function presetToInstant(choice: EndChoice, now: Date, zone: string, base?: string | null): string | null {
  if (choice === "none") return null;
  if (typeof choice === "object") {
    const day = parseDay(choice.date);
    return day ? endOfDay(day, zone).toISOString() : null;
  }
  const from = base && new Date(base).getTime() > now.getTime() ? new Date(base) : now;
  const start = dayIn(from, zone);
  const day = choice === "week" ? addDays(start, 7) : addMonths(start, choice === "month" ? 1 : 3);
  return endOfDay(day, zone).toISOString();
}

/** Why a hand-picked date is refused in the field, or `null` when it can be sent. */
export function dateRefusal(date: string, now: Date, zone: string): "empty" | "past" | "far" | null {
  const day = parseDay(date);
  if (!day) return "empty";
  const today = dayIn(now, zone);
  if (key(day) < key(today)) return "past";
  if (key(day) > key(addMonths(today, MAX_YEARS * 12))) return "far";
  return null;
}

/** The earliest and latest day the date input accepts, as `YYYY-MM-DD`. */
export function dateBounds(now: Date, zone: string): { min: string; max: string } {
  const text = (w: Wall) => `${w.y}-${String(w.m).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;
  const today = dayIn(now, zone);
  return { min: text(today), max: text(addMonths(today, MAX_YEARS * 12)) };
}

/**
 * The one zone guest and licence dates are read in, in both apps: the zone the person set on their
 * profile (what the rest of the app writes dates in), else the device's. A zone Intl does not know
 * is ignored.
 */
export function pickZone(profile: string | undefined | null, device: string): string {
  if (profile) {
    try {
      new Intl.DateTimeFormat(undefined, { timeZone: profile });
      return profile;
    } catch {
      // Unknown to this runtime: the device's.
    }
  }
  return device || "UTC";
}

/**
 * Calendar days from today to the day `iso` falls on, both read in `zone`: the 20th seen from the
 * 15th is 5, the last day is 0 ("today"), the day before it 1 ("tomorrow"). Never below zero.
 */
export function daysLeft(iso: string, now: Date, zone: string): number {
  const end = dayIn(new Date(iso), zone);
  const today = dayIn(now, zone);
  return Math.max(0, Math.round((Date.UTC(end.y, end.m - 1, end.d) - Date.UTC(today.y, today.m - 1, today.d)) / DAY_MS));
}

export function expiryTone(days: number): "calm" | "soon" {
  return days <= SOON_DAYS ? "soon" : "calm";
}

/** Only a guest has an end date; the field is offered for nobody else. */
export function showsEndDate(role: string): boolean {
  return role === "guest";
}

/**
 * "20 novembre 2026": the day the access ends, where the setter reads it. Given `now`, the year is
 * left out when the day falls in the current one ("12 décembre"), for a date in the middle of a sentence.
 */
export function endLabel(iso: string, locale: string, zone?: string, now?: Date): string {
  const at = new Date(iso);
  const sameYear = now !== undefined && new Intl.DateTimeFormat(PARTS_LOCALE, { year: "numeric", timeZone: zone }).format(at) === new Intl.DateTimeFormat(PARTS_LOCALE, { year: "numeric", timeZone: zone }).format(now);
  return new Intl.DateTimeFormat(locale, sameYear ? { day: "numeric", month: "long", timeZone: zone } : { dateStyle: "long", timeZone: zone }).format(at);
}

function capital(text: string, locale: string): string {
  return text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);
}

/** "Dans 5 jours", "Demain", "Aujourd'hui": how far an end lies, in the reader's language. */
export function inDaysLabel(days: number, locale: string): string {
  return capital(new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(days, "day"), locale);
}

/** "Il y a 3 jours": how long ago an access ended. */
export function keepLabel(endedAt: string, now: Date, locale: string): string {
  const days = Math.max(0, Math.floor((now.getTime() - new Date(endedAt).getTime()) / DAY_MS));
  return capital(new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-days, "day"), locale);
}

/** Why a choice cannot be sent yet (a hand-picked day missing or refused), or `null` when it can. */
export function choiceRefusal(choice: EndChoice, now: Date, zone: string): "empty" | "past" | "far" | null {
  return typeof choice === "object" ? dateRefusal(choice.date, now, zone) : null;
}

/** What the Members tab needs of a person to sort them. */
type Person = { role: string; bot: boolean };

/** Members (owners, administrators, members, bots) stay in the main table; guests have their own section. */
export function splitPeople<T extends Person>(people: T[]): { members: T[]; guests: T[] } {
  return { members: people.filter((p) => p.role !== "guest"), guests: people.filter((p) => p.role === "guest") };
}

/** How a guest's row reads: the end, how far it is, and whether it deserves the warning and Prolong. */
export function guestRow(guest: { expiresAt?: string }, now: Date, zone: string) {
  const end = guest.expiresAt ?? null;
  const days = end ? daysLeft(end, now, zone) : null;
  const tone = days === null ? "calm" : expiryTone(days);
  const soon = tone === "soon";
  return { end, days, tone, warn: soon, prolong: soon };
}

/** Ended accesses are for whoever manages people: the API refuses the list to anyone else. */
export function canSeeEnded(rights: string[]): boolean {
  return rights.includes("members.manage");
}

/** One sentence of a dialog, as a dictionary key and the names it mentions (roles held, in a list). */
export type Line = { key: string; names?: string[] };

type Held = { roleIds?: string[] };
type RoleLike = { id: string; name: string; systemKey?: string };

/**
 * What turning a person into a guest takes away and what stays, as sentences. The roles they hold
 * are named among what stays: they keep applying, under the guests' ceiling.
 */
export function standingLoss(member: Held, roles: RoleLike[]): { loses: Line[]; keeps: Line[] } {
  const held = roles.filter((r) => member.roleIds?.includes(r.id) && !r.systemKey).map((r) => r.name);
  return {
    loses: [{ key: "guests.loseView" }, { key: "guests.loseDirectory" }, { key: "guests.loseCeiling" }],
    keeps: [
      { key: "guests.keepChannels" },
      { key: "guests.keepMessages" },
      { key: "guests.keepGroups" },
      ...(held.length > 0 ? [{ key: "guests.keepRoles", names: held }] : []),
    ],
  };
}

/** What turning a guest into a member gives and costs, as sentences. */
export function standingGain(member: { expiresAt?: string }): Line[] {
  return [{ key: "guests.gainView" }, { key: "guests.gainSeat" }, ...(member.expiresAt ? [{ key: "guests.gainClearsDate" }] : [])];
}

/** The seats once one more person stops holding one; `null` when the space has no licence to count. */
export function seatsAfterInvite(licence: { seats: number; used: number } | undefined): { used: number; total: number } | null {
  return licence ? { used: Math.max(0, licence.used - 1), total: licence.seats } : null;
}

/** Which of a person's standing controls their management panel offers the viewer. */
export function gestionControls(member: { role: string; manageable?: boolean }, rights: string[]) {
  const manages = canSeeEnded(rights) && member.manageable !== false;
  return {
    endControl: manages && showsEndDate(member.role),
    toMember: manages && member.role === "guest",
    toGuest: manages && member.role === "member",
  };
}

/** The banner a guest sees under the space's name: with the end of their access, or without one. */
export function guestBanner(role: string, expiresAt: string | undefined): { dated: true; until: string } | { dated: false } | null {
  if (role !== "guest") return null;
  return expiresAt ? { dated: true, until: expiresAt } : { dated: false };
}

/** A group whose people are all guests (and which has some): it carries the "Invités" tag. */
export function isGuestsOnly(group: { memberIds: string[] }, people: { userId: string; role: string }[]): boolean {
  if (group.memberIds.length === 0) return false;
  const roles = new Map(people.map((p) => [p.userId, p.role]));
  return group.memberIds.every((id) => roles.get(id) === "guest");
}

/** The tag a group chip carries: "guests" when every person in the group is a guest, else none. */
export function groupTagFor(group: { memberIds: string[] }, people: { userId: string; role: string }[] | undefined): "guests" | null {
  return people && isGuestsOnly(group, people) ? "guests" : null;
}

/** The items of a guest's "..." menu in the Members tab. Passing to member is always a dialog, never a direct change. */
export function guestMenu(o: { licensed: boolean; canDate: boolean; hasEnd: boolean; canAct: boolean }): { id: "manage" | "changeDate" | "setDate" | "passerMembre" | "remove"; opens: "panel" | "dialog" | "confirm" }[] {
  if (!o.canAct) return [];
  return [
    { id: "manage", opens: "panel" },
    ...(o.canDate ? [{ id: o.hasEnd ? ("changeDate" as const) : ("setDate" as const), opens: "dialog" as const }] : []),
    // A community space changes the standing from the management panel's own select.
    ...(o.licensed ? [{ id: "passerMembre" as const, opens: "dialog" as const }] : []),
    { id: "remove", opens: "confirm" },
  ];
}

/** The dictionary key (under `guests`) of what an expiry refusal says, or `null` for any other code. */
export function guestRefusalKey(code: string): string | null {
  const keys: Record<string, string> = {
    bad_expiry: "guests.refusalBadExpiry",
    guest_only: "guests.refusalGuestOnly",
    access_ended: "guests.refusalAccessEnded",
    not_ended: "guests.refusalNotEnded",
    access_ended_for_good: "guests.endedForGood",
  };
  return keys[code] ?? null;
}
