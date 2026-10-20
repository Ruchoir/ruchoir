/**
 * Where an invitation to a space of another instance leads (ADR 0007): to that instance when the
 * phone is signed in there, to signing in again when its session there ended, else to adding it.
 * Free of React so Node tests it.
 */

export type InvitationRoute = { kind: "switch"; id: string } | { kind: "renew"; id: string } | { kind: "add" };

type AccountLike = { id: string; origin: string; status: { kind: string } };

export function invitationRoute(accounts: AccountLike[], origin: string): InvitationRoute {
  const known = accounts.find((account) => account.origin === origin);
  if (!known) return { kind: "add" };
  return known.status.kind === "signedIn" ? { kind: "switch", id: known.id } : { kind: "renew", id: known.id };
}
