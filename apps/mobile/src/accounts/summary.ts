/**
 * What the space sheet and the badges draw from every instance's summary (ADR 0007). Free of React
 * so Node tests it.
 */
import type { Workspace } from "@ruchoir/client";

export type SectionState = "signedIn" | "signedOut" | "offline" | "checking";

/** One instance in the space sheet: its spaces, or why it shows none. */
export type SpaceSection = { id: string; origin: string; state: SectionState; spaces: Workspace[] | null };

type AccountLike = { id: string; origin: string; status: { kind: SectionState } };

/** The instances in the registry's order, each with the spaces its scope last published. */
export function groupSpaces(accounts: AccountLike[], summaries: Record<string, { spaces: Workspace[] } | undefined>): SpaceSection[] {
  return accounts.map((account) => ({
    id: account.id,
    origin: account.origin,
    state: account.status.kind,
    spaces: account.status.kind === "signedIn" ? (summaries[account.id]?.spaces ?? null) : null,
  }));
}

/** The unread notifications of every instance, for the bell's badge. */
export function unreadEverywhere(summaries: Record<string, { unreadNotifications: number } | undefined>, ids: string[]): number {
  return ids.reduce((sum, id) => sum + (summaries[id]?.unreadNotifications ?? 0), 0);
}

/** What the person sees of an instance: its host. */
export const hostOf = (origin: string) => origin.replace(/^https:\/\//, "");
