/** What the guest notices say, and how the app notices a space that ended for its guest. */

import { daysLeft } from "./guests.ts";
import { tidyPeriods } from "./sentences.ts";

type NoticeLike = { kind: string; actor: string; spaceName: string; daysLeft?: number; endsAt?: string };

/** "dans 7 jours", "demain": how far an end lies, to sit in the middle of a sentence. */
export function whenLabel(days: number, locale: string): string {
  return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(days, "day").toLocaleLowerCase(locale);
}

/**
 * The line of a guest notice: for whoever manages the guest ("L'accès de X se termine dans 7 jours")
 * or for the guest ("Votre accès à Y se termine demain"). `null` for any other kind. The words come
 * from the caller, which holds the translator.
 *
 * The notice carries the days left on the day it was sent: with `at` (the clock and the zone of the
 * reader) and the end, the days are counted now, so a notice read three days later says so.
 */
export function guestNoticeSummary(
  n: NoticeLike,
  locale: string,
  say: (which: "soon" | "ending", vars: Record<string, string>) => string,
  at?: { now: Date; zone: string },
): string | null {
  const days = at && n.endsAt ? daysLeft(n.endsAt, at.now, at.zone) : (n.daysLeft ?? 1);
  const when = whenLabel(days, locale);
  if (n.kind === "guest_expiry_soon") return say("soon", { name: n.actor, when });
  if (n.kind === "guest_access_ending") return say("ending", { space: n.spaceName, when });
  return null;
}

/**
 * The second line of a guest notice. For whoever manages the guest: their title when they have one,
 * the end and the offer to extend. For the guest: what happens after the end and who to ask (a
 * neutral sentence when no one is named). `null` for any other kind, or when the end is unknown.
 */
export function guestNoticeDetail(
  n: { kind: string; endsAt?: string; guestTitle?: string; contactName?: string },
  formatDay: (iso: string) => string,
  say: (which: "soon" | "soonBare" | "ending" | "endingBare", vars: Record<string, string>) => string,
): string | null {
  if (!n.endsAt) return null;
  const date = formatDay(n.endsAt);
  if (!date) return null;
  // A short date ends in its own period ("7 nov."), and the sentence around it ends with another.
  if (n.kind === "guest_expiry_soon") return tidyPeriods(n.guestTitle ? say("soon", { title: n.guestTitle, date }) : say("soonBare", { date }));
  if (n.kind === "guest_access_ending") return tidyPeriods(n.contactName ? say("ending", { date, contact: n.contactName }) : say("endingBare", { date }));
  return null;
}

/**
 * The spaces that were in the list and are not any more, and that nobody was told about yet. `told`
 * is kept by the caller and filled here, so the notice shows once however many frames follow.
 */
export function endedSpaces<T extends { id: string }>(before: T[], after: { id: string }[], told: Set<string>): T[] {
  const still = new Set(after.map((s) => s.id));
  const gone = before.filter((s) => !still.has(s.id) && !told.has(s.id));
  for (const s of gone) told.add(s.id);
  return gone;
}

/**
 * Where a guest notice leads. For a manager (`guest_expiry_soon`, which names the guest in its
 * `actor_id`): Members with the prolong dialog open for that guest; without the id, Members alone.
 * For the guest (`guest_access_ending`): the space's home. Any other kind leads nowhere from here.
 */
export function noticeTarget(n: { kind: string; spaceId: string; actorId?: string }):
  | { action: "prolong"; spaceId: string; userId: string }
  | { action: "members"; spaceId: string }
  | { action: "space"; spaceId: string }
  | null {
  if (n.kind === "guest_expiry_soon") return n.actorId ? { action: "prolong", spaceId: n.spaceId, userId: n.actorId } : { action: "members", spaceId: n.spaceId };
  if (n.kind === "guest_access_ending") return { action: "space", spaceId: n.spaceId };
  return null;
}

/**
 * What a vanished space says: a guest whose access ended is told so (and that their messages stay);
 * anyone else, who was removed or whose space is gone, is told they are no longer part of it.
 */
export function endedNoticeKeys(role: string | undefined): { title: string; body?: string } {
  return role === "guest" ? { title: "guests.endedNotice", body: "guests.endedNoticeBody" } : { title: "guests.leftNotice" };
}
