import type { Member } from "@/lib/data/api";
import { choiceRefusal, presetToInstant, type EndChoice } from "./guestLogic.ts";

/** Which person, which end, and when "now" and where "today" are for turning the end into an instant. */
export type ExpiryRequest = {
  spaceId: string;
  userId: string;
  choice: EndChoice;
  now: Date;
  zone: string;
  /** The current end (RFC 3339): a duration is added to it when it still lies ahead. */
  base?: string | null;
};

/** The instant to send, or a refusal before anything leaves: a day left empty must never mean "no end". */
function instantOf(request: ExpiryRequest): string | null {
  if (choiceRefusal(request.choice, request.now, request.zone) !== null) throw new Error("the end date is not valid");
  return presetToInstant(request.choice, request.now, request.zone, request.base);
}

/** Move, set or remove a guest's end date, then read the people again. Throws what the API throws. */
export async function saveGuestExpiry(
  api: { setGuestExpiry: (spaceId: string, userId: string, expiresAt: string | null) => Promise<Member | void> },
  request: ExpiryRequest,
  refresh: () => Promise<void>,
): Promise<void> {
  await api.setGuestExpiry(request.spaceId, request.userId, instantOf(request));
  await refresh();
}

/** Bring an ended guest back with the chosen end, then read the people and the ended list again. */
export async function reactivateGuestAccess(
  api: { reactivateGuest: (spaceId: string, userId: string, expiresAt: string | null) => Promise<Member | void> },
  request: ExpiryRequest,
  refresh: () => Promise<void>,
): Promise<void> {
  await api.reactivateGuest(request.spaceId, request.userId, instantOf(request));
  await refresh();
}

/** Removing for good is confirmed first: asking only names who, and nothing is removed until it is confirmed. */
export type Removal = { userId: string; name: string } | null;

export function askRemoval(person: { userId: string; name: string }): Removal {
  return { userId: person.userId, name: person.name };
}

/** Remove the person the confirmation named; with nothing asked, nothing happens (`false`). */
export async function confirmRemoval(
  api: { removeMember: (spaceId: string, userId: string) => Promise<void> },
  spaceId: string,
  pending: Removal,
  refresh: () => Promise<void>,
): Promise<boolean> {
  if (!pending) return false;
  await api.removeMember(spaceId, pending.userId);
  await refresh();
  return true;
}

/** The seats refusal an API error carries (`402 seats_full`), or `null` for any other failure. */
export function seatsFullOf(err: unknown): { seats: number; pricingUrl: string } | null {
  const e = err as { status?: number; body?: { error?: string; seats?: number; pricing_url?: string } } | null;
  if (e?.status !== 402 || e.body?.error !== "seats_full") return null;
  return { seats: e.body.seats ?? 0, pricingUrl: e.body.pricing_url ?? "" };
}

type StandingApi = {
  setMemberRole: (spaceId: string, userId: string, role: string, options?: { expiresAt?: string | null }) => Promise<unknown>;
};

/**
 * Turn a guest into a member. A full licence is not a failure to throw but an answer to show: the
 * guest keeps their access and the dialog names the seats and the way to a bigger licence.
 */
export async function passerMembre(
  api: StandingApi,
  request: { spaceId: string; userId: string },
  refresh: () => Promise<void>,
): Promise<{ ok: true } | { ok: false; seatsFull: { seats: number; pricingUrl: string } }> {
  try {
    await api.setMemberRole(request.spaceId, request.userId, "member");
  } catch (err) {
    const full = seatsFullOf(err);
    if (full) return { ok: false, seatsFull: full };
    throw err;
  }
  await refresh();
  return { ok: true };
}

/** Turn a member into a guest, with an end date or none; the choice is checked before anything is sent. */
export async function passerInvite(api: StandingApi, request: ExpiryRequest, refresh: () => Promise<void>): Promise<void> {
  await api.setMemberRole(request.spaceId, request.userId, "guest", { expiresAt: instantOf(request) });
  await refresh();
}
