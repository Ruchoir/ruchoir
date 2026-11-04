/**
 * "Pourquoi ?" in sentences: each step the engine took, and each decision, as a dictionary key and
 * the plain values that fill it. The screen draws names (permissions, groups) as it likes; nothing
 * here reads a translation.
 */

import { levelLabelKey } from "./access.ts";

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

export type Sentence = {
  key: string;
  values: Record<string, string>;
  /** How many permissions the sentence names: the translator's `count`, so the verb agrees (`_one`, `_other`...). */
  count: number;
};

/** How the person holds a role: given to them, through one or several groups, or both. */
export function roleSentence(role: RoleLike): Omit<Sentence, "count"> {
  const groups = role.viaGroups.map((g) => g.name).join(", ");
  if (role.viaGroups.length === 0) return { key: "why.role.direct", values: { role: role.name } };
  return { key: role.direct ? "why.role.directAndGroup" : "why.role.viaGroup", values: { role: role.name, groups } };
}

/** The sentence of one step: `why.step.<kind>.<granted|removed>`, or the unknown one. */
export function stepSentence(step: StepLike & { permissions?: string[] }): Sentence {
  const count = Math.max(1, step.permissions?.length ?? 1);
  if (!(STEP_KINDS as readonly string[]).includes(step.kind)) return { key: "why.step.unknown", values: {}, count };
  const values: Record<string, string> = {
    target: step.target && !step.target.hidden ? (step.target.name ?? "") : "",
    where: step.level && !step.level.hidden ? (step.level.name ?? "") : "",
  };
  if (step.role) Object.assign(values, roleSentence(step.role).values);
  return { key: `why.step.${step.kind}.${step.effect}`, values, count };
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

/** A role as the roles list knows it. */
type RoleRef = { id: string; name: string; systemKey?: "administrator" | "members" | "guests" };

/**
 * How the UI names the target or role of a step: the base roles (`@members`, `@guests`) and the
 * system roles ("Administrator", "Members", "Guests" as stored) by their translated dictionary key,
 * anything else by its name. Nothing for a hidden place or no target; the dialog words that.
 */
export function labelOf(ref: Ref | undefined, roles: RoleRef[]): { key?: string; name?: string } {
  if (!ref || ref.hidden) return {};
  if (ref.kind === "everyone") return { key: (ref.name ?? "").startsWith("@guests") ? "access.allGuests" : "channel.everyoneInSpace" };
  if (ref.kind === "role") {
    const role = roles.find((r) => r.id === ref.id);
    const system = role?.systemKey ?? (ref.name === "Administrator" ? "administrator" : undefined);
    if (system === "administrator") return { key: "role.admin" };
    if (system === "members") return { key: "roles.everyone" };
    if (system === "guests") return { key: "roles.guests" };
  }
  return ref.name ? { name: ref.name } : {};
}

/** One sentence's worth of steps: the same origin, one after the other, listing their permissions. */
export type StepGroup = StepLike & { permissions: string[]; ns: number[] };

/**
 * The steps as the mockup reads them: consecutive steps of one origin (base, one role, one rule at
 * one place) and one effect make a single sentence naming every permission, in the engine's order.
 */
export function groupSteps(steps: StepLike[]): StepGroup[] {
  const groups: StepGroup[] = [];
  const origin = (s: StepLike) =>
    [s.kind, s.effect, s.role?.id ?? "", s.target?.kind ?? "", s.target?.id ?? s.target?.name ?? "", s.level?.id ?? s.level?.name ?? (s.level?.hidden ? "hidden" : ""), s.ruleLevel ?? ""].join("|");
  for (const step of steps) {
    const last = groups[groups.length - 1];
    if (last && origin(last) === origin(step)) {
      last.permissions.push(step.permission);
      last.ns.push(step.n);
    } else {
      groups.push({ ...step, permissions: [step.permission], ns: [step.n] });
    }
  }
  return groups;
}

/** Whether none of the locks (private, guest ceiling, owner, archive) changed anything: the frame says so in one line. */
export function locksQuiet(steps: { kind: string }[]): boolean {
  return !steps.some((s) => ["private_lock", "guest_ceiling", "owner", "archived"].includes(s.kind));
}

type ResourceKind = "channel" | "file" | "calendar";

/** The results as the mockup draws them, in the vocabulary of the levels: one card per level of rights. */
export type Card = {
  id: string;
  labelKey: string;
  granted: boolean;
  reason?: CardReason;
  /** `askManage`: a public link wants the right to manage first. */
  hint?: "askManage";
};

const CARDS: Record<ResourceKind, { id: string; labelKey: string; permissions: string[] }[]> = {
  file: [
    { id: "view", labelKey: "why.card.view", permissions: ["files.view"] },
    { id: "edit", labelKey: "access.level.file.contribute", permissions: ["files.create", "files.edit"] },
    { id: "manage", labelKey: "access.level.manage", permissions: ["files.manage"] },
    { id: "publicLink", labelKey: "access.publicLink", permissions: ["files.public_link"] },
  ],
  channel: [
    { id: "view", labelKey: "why.card.view", permissions: ["channel.view"] },
    { id: "participate", labelKey: "access.level.channel.contribute", permissions: ["message.send", "message.attach", "message.pin"] },
    { id: "manage", labelKey: "access.level.manage", permissions: ["message.manage", "channel.members.manage", "channel.manage"] },
  ],
  calendar: [
    { id: "view", labelKey: "why.card.view", permissions: ["calendar.view"] },
    { id: "write", labelKey: "access.level.calendar.contribute", permissions: ["calendar.write"] },
    { id: "manage", labelKey: "access.level.manage", permissions: ["calendar.manage"] },
  ],
};

/**
 * The lock (private, guest ceiling, owner, archive) that removed one of a level's permissions: the
 * one the result points at, else the last one listed for those permissions.
 */
function takenBy(permissions: string[], own: (ResultLike | undefined)[], steps: StepLike[]): StepLike | undefined {
  for (const r of own) {
    const pointed = r && !r.granted && r.reasonStep !== undefined ? steps.find((s) => s.n === r.reasonStep) : undefined;
    if (pointed?.effect === "removed" && LOCKS.includes(pointed.kind)) return pointed;
  }
  return steps.filter((s) => s.effect === "removed" && LOCKS.includes(s.kind) && permissions.includes(s.permission)).at(-1);
}

/**
 * The cards of the result: a level is granted when every one of its permissions is ("Modifier" needs
 * create and edit both), and its reason is the first step that granted one of them. A level none of
 * whose permissions the explanation lists is left out.
 */
export function cardsOf(kind: ResourceKind, result: ResultLike[], steps: StepLike[]): Card[] {
  const cards: Card[] = [];
  for (const def of CARDS[kind]) {
    const own = def.permissions.map((p) => result.find((r) => r.permission === p));
    if (own.every((r) => r === undefined)) continue;
    const granted = own.every((r) => r?.granted === true);
    const decisive = own.find((r) => r?.granted && r.reasonStep !== undefined);
    const card: Card = { id: def.id, labelKey: def.labelKey, granted };
    if (granted && decisive) card.reason = cardOf(decisive, steps).reason;
    if (!granted) {
      // What took it away, so a right a rule granted and a lock removed does not read "no rule grants it".
      const taker = takenBy(def.permissions, own, steps);
      if (taker) card.reason = cardOf({ permission: taker.permission, granted: false, reasonStep: taker.n }, steps).reason;
    }
    if (!granted && def.id === "publicLink") card.hint = "askManage";
    cards.push(card);
  }
  return cards;
}

/** A level of the chain the person's access passes through: the space's folders, then the item. */
export type ChainLevel = { id?: string; name: string; item: boolean };

export type Paragraph =
  | { type: "base"; group: StepGroup }
  | { type: "roles"; roles: RoleLike[] }
  | { type: "space"; role: RoleLike; permissions: string[]; effect: "granted" | "removed" }
  | { type: "level"; name: string | undefined; hidden: boolean; item: boolean; kind: string; rules: StepGroup[] }
  | { type: "locks"; groups: StepGroup[] }
  | { type: "quiet" }
  | { type: "other"; group: StepGroup };

const LOCKS = ["private_lock", "guest_ceiling", "owner", "archived"];

/**
 * The explanation as the mockup reads it, in the order the engine works: the base role, the roles the
 * person holds and the groups carrying them, what those roles give in the space, then one line per
 * level of the chain (each folder from the top, then the item) with its rules, then the locks.
 * Every step the API gives appears once.
 */
export function outline(steps: StepLike[], chain: ChainLevel[], held: RoleLike[] = []): Paragraph[] {
  const groups = groupSteps(steps);
  const out: Paragraph[] = [];
  for (const g of groups.filter((g) => g.kind === "base")) out.push({ type: "base", group: g });

  const roleSteps = groups.filter((g) => g.kind === "role" && g.role);
  // The person's own list first (every role they hold, even one no step names), then any role a step
  // names that the list lacks (an older server sends no list).
  const roles: RoleLike[] = [...held];
  for (const g of roleSteps) if (g.role && !roles.some((r) => r.id === g.role!.id)) roles.push(g.role);
  if (roles.length > 0) out.push({ type: "roles", roles });
  for (const g of roleSteps) if (g.role) out.push({ type: "space", role: g.role, permissions: g.permissions, effect: g.effect });

  const rules = groups.filter((g) => g.kind === "rule");
  const placed = new Set<StepGroup>();
  const levelOf = (g: StepGroup) => chain.findIndex((c) => (c.id && g.level?.id === c.id) || (!c.id && !g.level?.hidden && g.level?.name === c.name));
  for (const c of chain) {
    const mine = rules.filter((g) => levelOf(g) === chain.indexOf(c));
    mine.forEach((g) => placed.add(g));
    out.push({ type: "level", name: c.name, hidden: false, item: c.item, kind: "file", rules: mine });
  }
  // Rules at a place the chain does not name (hidden from the viewer, or another place): their own line.
  const strays = rules.filter((g) => !placed.has(g));
  const seen: string[] = [];
  for (const g of strays) {
    const id = g.level?.hidden ? "hidden" : (g.level?.id ?? g.level?.name ?? "");
    if (seen.includes(id)) continue;
    seen.push(id);
    const same = strays.filter((x) => (x.level?.hidden ? "hidden" : (x.level?.id ?? x.level?.name ?? "")) === id);
    out.push({ type: "level", name: g.level?.hidden ? undefined : g.level?.name, hidden: g.level?.hidden === true, item: false, kind: g.level?.kind ?? "file", rules: same });
  }

  const locks = groups.filter((g) => LOCKS.includes(g.kind));
  if (locks.length > 0) out.push({ type: "locks", groups: locks });
  for (const g of groups.filter((g) => !["base", "role", "rule", ...LOCKS].includes(g.kind))) out.push({ type: "other", group: g });
  if (locks.length === 0) out.push({ type: "quiet" });
  return out;
}

/**
 * The dictionary key of the word naming a level of the chain ("Dossier", "Fichier", "Canal",
 * "Agenda"). Folders and files are both `file` on the wire, so the item takes the word of what is
 * being explained, and every level above it is a folder. Nothing for a hidden place.
 */
export function levelWordKey(level: { item: boolean; hidden: boolean }, kind: ResourceKind, isFolder: boolean): string | undefined {
  if (level.hidden) return undefined;
  if (!level.item) return "files.typeFolder";
  if (kind === "channel") return "calendar.channel";
  if (kind === "calendar") return "calendar.title";
  return isFolder ? "files.typeFolder" : "message.file";
}

/** Sentences one after the other: each after the first starts with a capital, in the reader's language. */
export function joinSentences(sentences: string[], locale?: string): string {
  return sentences.map((s, i) => (i === 0 || s.length === 0 ? s : s.charAt(0).toLocaleUpperCase(locale) + s.slice(1))).join(" ");
}
