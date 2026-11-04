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
