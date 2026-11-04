/**
 * Group mentions on the phone: how a typed `@` offers groups and how a message names one. The
 * rules are the server's (`whole_name_mentioned`) and the web's (`permissionsLogic/mentions.ts`),
 * so a pill lights exactly when a notification goes out and a message reads the same everywhere.
 * The body carries nothing but the name: `@Comptabilité`, `@Chantier Rennes`.
 */
import type { Group } from "@ruchoir/client";
import { foldMention, groupHitsFor } from "@ruchoir/client/permissionsLogic";

// The matching itself (`matchGroupMention`, `foldMention`) is shared with the web: `@ruchoir/client`.

/** The group a pill names (`@comptabilite`, spaces as typed), folded as the parser folds, so a lit pill always opens its group. */
export function groupByName<G extends Pick<Group, "name">>(groups: readonly G[], mention: string): G | undefined {
  const wanted = foldMention(mention.replace(/^@/, "").replace(/\s+/g, " ").trim());
  return groups.find((g) => foldMention(g.name.replace(/\s+/g, " ").trim()) === wanted);
}

/** The groups a mention being typed offers (none for a guest), with how many people each holds. */
export function mentionableGroups<G extends Pick<Group, "id" | "name" | "source" | "memberIds" | "managerIds" | "roleIds">>(
  viewerRole: string | undefined,
  groups: G[],
  query: string,
) {
  // A double space in what was typed is the same name ("Chantier  Re").
  return groupHitsFor(viewerRole, groups, query.replace(/\s+/g, " "), []);
}

export type OrderedHit<R, G, P> =
  | { kind: "room"; item: R }
  | { kind: "group"; item: G }
  | { kind: "person"; item: P };

/** What the menu lists: the room-wide names, then groups, then people (the web's order), `limit` in all. */
export function mentionOrder<R, G, P>(parts: { rooms: R[]; groups: G[]; people: P[] }, limit: number): OrderedHit<R, G, P>[] {
  const all: OrderedHit<R, G, P>[] = [
    ...parts.rooms.map((item) => ({ kind: "room" as const, item })),
    ...parts.groups.map((item) => ({ kind: "group" as const, item })),
    ...parts.people.map((item) => ({ kind: "person" as const, item })),
  ];
  return all.slice(0, limit);
}
