/**
 * "Pourquoi ?" in sentences: each step the engine took, and each decision, as a dictionary key and
 * the plain values that fill it. The screen draws names (permissions, groups) as it likes; nothing
 * here reads a translation.
 */

import { levelLabelKey } from "./accessLogic.ts";

type Ref = { kind: string; id?: string; name?: string; hidden: boolean };
export type RoleLike = { id: string; name: string; direct: boolean; viaGroups: { id: string; name: string }[] };
export type StepLike = {
  n: number;
  kind: string;
  permission: string;
  effect: "granted" | "removed";
  role?: RoleLike;
  target?: Ref;
  level?: Ref;
  /** For a rule step: the level of the rule behind it. */
  ruleLevel?: "none" | "read" | "contribute" | "manage" | "custom";
};
export type ResultLike = { permission: string; granted: boolean; reasonStep?: number };

/** Every kind of step the API reports, in the order they are met. */
export const STEP_KINDS = [
  "base", "role", "rule", "private_lock", "guest_ceiling", "owner", "author", "archived", "joined",
  "unseen", "conversation", "message", "event",
] as const;

export type Sentence = { key: string; values: Record<string, string> };

/** How the person holds a role: given to them, through one or several groups, or both. */
export function roleSentence(role: RoleLike): Sentence {
  const groups = role.viaGroups.map((g) => g.name).join(", ");
  if (role.viaGroups.length === 0) return { key: "why.role.direct", values: { role: role.name } };
  return { key: role.direct ? "why.role.directAndGroup" : "why.role.viaGroup", values: { role: role.name, groups } };
}

/** The sentence of one step: `why.step.<kind>.<granted|removed>`, or the unknown one. */
export function stepSentence(step: StepLike): Sentence {
  if (!(STEP_KINDS as readonly string[]).includes(step.kind)) return { key: "why.step.unknown", values: {} };
  const values: Record<string, string> = {
    target: step.target && !step.target.hidden ? (step.target.name ?? "") : "",
    where: step.level && !step.level.hidden ? (step.level.name ?? "") : "",
  };
  if (step.role) Object.assign(values, roleSentence(step.role).values);
  return { key: `why.step.${step.kind}.${step.effect}`, values };
}

/** A result card: the decision, and the step that decided it when the explanation holds it. */
export type CardReason = {
  n: number;
  kind: string;
  /** A rule's place by name; nothing when it is hidden from the viewer. */
  where?: string;
  hiddenPlace?: boolean;
  /** A rule's level, as the dictionary key of the access dialog's words for that kind of resource. */
  levelKey?: string;
};

export function cardOf(
  result: ResultLike,
  steps: { n: number; kind: string; level?: Ref; ruleLevel?: StepLike["ruleLevel"] }[],
): { permission: string; granted: boolean; reason?: CardReason } {
  const found = result.reasonStep === undefined ? undefined : steps.find((s) => s.n === result.reasonStep);
  let reason: CardReason | undefined = found ? { n: found.n, kind: found.kind } : undefined;
  // A rule says where it sits and at what level: "par une regle sur Compta, niveau Modifier".
  if (found && found.kind === "rule" && found.level && found.ruleLevel) {
    const place = found.level;
    const resource = place.kind === "channel" || place.kind === "calendar" ? place.kind : "file";
    reason = { n: found.n, kind: "rule", where: place.hidden ? undefined : place.name, hiddenPlace: place.hidden, levelKey: levelLabelKey(resource, found.ruleLevel) };
  }
  return { permission: result.permission, granted: result.granted, reason };
}

/** The dictionary key of a card's reason, for a step kind (an unknown one reads as another step). */
export function reasonKey(kind: string): string {
  return (STEP_KINDS as readonly string[]).includes(kind) ? `why.reason.${kind}` : "why.reason.other";
}

/**
 * What a person already has a resource through, named: the group that carries their role, the group
 * or role a rule is aimed at, or the role itself. Nothing when the view comes from the base role,
 * ownership or anything that is not a line of this dialog, and nothing when it is refused.
 */
export function alreadyVia(why: { steps: StepLike[]; result: ResultLike[] }, viewPermission: string): string | undefined {
  const result = why.result.find((r) => r.permission === viewPermission);
  if (!result?.granted || result.reasonStep === undefined) return undefined;
  const step = why.steps.find((s) => s.n === result.reasonStep);
  if (!step) return undefined;
  if (step.kind === "role" && step.role) return step.role.viaGroups[0]?.name ?? step.role.name;
  if (step.kind === "rule" && step.target && !step.target.hidden && step.target.kind !== "everyone") return step.target.name;
  return undefined;
}
