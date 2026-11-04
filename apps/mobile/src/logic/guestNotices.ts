/**
 * What the phone decides about guests' access, without drawing anything: where a guest notice leads
 * (from the list or from a tap, the same data), when a guest's own access shows its banner and its
 * warning card. The wording and the dates come from `@ruchoir/client/permissionsLogic`, shared with
 * the web.
 */
import { daysLeft, endedNoticeKeys, endedSpaces, expiryTone, guestBanner, noticeTarget, SOON_DAYS } from "@ruchoir/client/permissionsLogic";

/** The two guest notices; a tap on either is handled by `tapTarget` from this data. */
export function isGuestNotice(kind: string): boolean {
  return kind === "guest_expiry_soon" || kind === "guest_access_ending";
}

/** The data a guest notice carries to wait for its instance, as a tap carries it (`push/tap.ts`); `null` for any other kind. */
export function noticeData(n: { kind: string; spaceId: string; actorId?: string }): Record<string, string> | null {
  if (!isGuestNotice(n.kind) || noticeTarget({ kind: n.kind, spaceId: n.spaceId }) === null) return null;
  const data: Record<string, string> = { kind: n.kind };
  if (n.spaceId) data.space_id = n.spaceId;
  if (n.actorId) data.actor_id = n.actorId;
  return data;
}

export { noticeTarget };

/** Whether the person who may manage guests is offered Prolonger on a notice. */
export function offersProlong(kind: string): boolean {
  return kind === "guest_expiry_soon";
}

export type GuestBannerState = { until: string; days: number; tone: "calm" | "soon"; card: boolean };

/** The banner of a guest whose own access ends: how far it lies, its tone, and whether the warning card shows (within `SOON_DAYS`). */
export function guestBannerFor(space: { role: string; expiresAt?: string } | null, now: Date, zone: string): GuestBannerState | null {
  if (!space) return null;
  const banner = guestBanner(space.role, space.expiresAt);
  if (!banner || !banner.dated) return null;
  const days = daysLeft(banner.until, now, zone);
  return { until: banner.until, days, tone: expiryTone(days), card: days <= SOON_DAYS };
}

/** The space a link names by its address slug, or `undefined` while the list is not there yet. */
export function spaceBySlug<T extends { slug: string }>(spaces: T[] | undefined, slug: string): T | undefined {
  return spaces?.find((s) => s.slug === slug);
}

/** What a waiting prolong link does with the space list: wait for it, open the space it names, or give up when that space is not there. */
export function prolongStep<T extends { slug: string }>(spaces: T[] | undefined, slug: string): { kind: "wait" } | { kind: "open"; space: T } | { kind: "drop" } {
  if (!spaces) return { kind: "wait" };
  const space = spaceBySlug(spaces, slug);
  return space ? { kind: "open", space } : { kind: "drop" };
}

/**
 * What to tell about the spaces that left the list since the last read: a guest whose access ended,
 * a member who was removed. Once per space (`told` is kept by the caller). The keys are the ones the
 * web uses, `guests.endedNotice`, `guests.endedNoticeBody` and `guests.leftNotice`.
 *
 * Only a space the server said something about is told (`caused`: a rights change, or a removal; as
 * the web, which speaks on a permissions event only), and never one this phone just deleted or left
 * (`muted`). A space that merely vanished from a list (deleted by its owner, a sign-out, an instance
 * switch, an empty answer) is not an ended access.
 */
export function spaceEndings(
  before: { id: string; name: string; role?: string }[],
  after: { id: string }[],
  told: Set<string>,
  ctx: { caused: ReadonlySet<string>; muted: ReadonlySet<string> },
): { space: string; title: "guests.endedNotice" | "guests.leftNotice"; body?: "guests.endedNoticeBody" }[] {
  const candidates = before.filter((s) => ctx.caused.has(s.id) && !ctx.muted.has(s.id));
  return endedSpaces(candidates, after, told).map((s) => {
    const keys = endedNoticeKeys(s.role);
    return { space: s.name, title: keys.title as "guests.endedNotice" | "guests.leftNotice", ...(keys.body ? { body: keys.body as "guests.endedNoticeBody" } : {}) };
  });
}

/** The space an event may have ended the access of: its rights moved, or the server removed the person from it. */
export function endingCause(e: { type: string; spaceId?: string; removed?: { spaceId: string; reason: string } }): string | null {
  if (e.type === "permissions" && e.spaceId) return e.spaceId;
  if (e.type === "spaces" && e.removed?.reason === "removed") return e.removed.spaceId;
  return null;
}
