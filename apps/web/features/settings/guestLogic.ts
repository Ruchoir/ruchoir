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

/** Whole days left before `iso` (a started day counts), never below zero. */
export function daysLeft(iso: string, now: Date): number {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - now.getTime()) / DAY_MS));
}

export function expiryTone(days: number): "calm" | "soon" {
  return days <= SOON_DAYS ? "soon" : "calm";
}

/** Only a guest has an end date; the field is offered for nobody else. */
export function showsEndDate(role: string): boolean {
  return role === "guest";
}

/** "20 novembre 2026": the day the access ends, where the setter reads it. */
export function endLabel(iso: string, locale: string, zone?: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: zone }).format(new Date(iso));
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

/** The zone this browser reads dates in. */
export function browserZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** What the Members tab needs of a person to sort them. */
type Person = { role: string; bot: boolean };

/** Members (owners, administrators, members, bots) stay in the main table; guests have their own section. */
export function splitPeople<T extends Person>(people: T[]): { members: T[]; guests: T[] } {
  return { members: people.filter((p) => p.role !== "guest"), guests: people.filter((p) => p.role === "guest") };
}

/** How a guest's row reads: the end, how far it is, and whether it deserves the warning and Prolong. */
export function guestRow(guest: { expiresAt?: string }, now: Date) {
  const end = guest.expiresAt ?? null;
  const days = end ? daysLeft(end, now) : null;
  const tone = days === null ? "calm" : expiryTone(days);
  const soon = tone === "soon";
  return { end, days, tone, warn: soon, prolong: soon };
}

/** Ended accesses are for whoever manages people: the API refuses the list to anyone else. */
export function canSeeEnded(rights: string[]): boolean {
  return rights.includes("members.manage");
}
