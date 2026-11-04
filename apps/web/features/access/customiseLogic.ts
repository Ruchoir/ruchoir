/**
 * What the "Personnaliser" dialog decides without drawing anything: the three states of a
 * permission (Hérité, Autorisé, Refusé) and how they become an allow list and a deny list, which
 * permissions the editor cannot touch and why, and where the button is not offered at all.
 */

export type Kind = "channel" | "file" | "calendar";
type Level = "none" | "read" | "contribute" | "manage" | "custom";

export type State = "inherited" | "allow" | "deny";
/** A permission name to its state; a name that is absent is inherited. */
export type Draft = Record<string, State>;
export type LockReason = "not_held" | "guest";

export type Group = { group: "read" | "participate" | "manage"; permissions: string[] };

/** The permissions of each family, by the preset level that introduces them (the catalogue's order). */
const GROUPS: Record<Kind, Group[]> = {
  channel: [
    { group: "read", permissions: ["channel.view", "message.react"] },
    { group: "participate", permissions: ["message.send", "message.attach", "message.pin", "message.mention_all"] },
    { group: "manage", permissions: ["message.manage", "channel.members.manage", "channel.manage"] },
  ],
  file: [
    { group: "read", permissions: ["files.view"] },
    { group: "participate", permissions: ["files.create", "files.edit"] },
    { group: "manage", permissions: ["files.manage", "files.public_link"] },
  ],
  calendar: [
    { group: "read", permissions: ["calendar.view"] },
    { group: "participate", permissions: ["calendar.write"] },
    { group: "manage", permissions: ["calendar.manage"] },
  ],
};

export function groupsOf(kind: Kind): Group[] {
  return GROUPS[kind];
}

const catalogue = (kind: Kind): string[] => GROUPS[kind].flatMap((g) => g.permissions);

export function draftOf(rule: { allow: string[]; deny: string[] }): Draft {
  const draft: Draft = {};
  for (const name of rule.allow) draft[name] = "allow";
  for (const name of rule.deny) draft[name] = "deny";
  return draft;
}

export function stateOf(draft: Draft, permission: string): State {
  return draft[permission] ?? "inherited";
}

export function setState(draft: Draft, permission: string, state: State): Draft {
  const next = { ...draft };
  if (state === "inherited") delete next[permission];
  else next[permission] = state;
  return next;
}

/** The request body: each permission in one list at most, in the catalogue's order. */
export function ruleOf(kind: Kind, draft: Draft): { allow: string[]; deny: string[] } {
  const names = catalogue(kind);
  return {
    allow: names.filter((n) => draft[n] === "allow"),
    deny: names.filter((n) => draft[n] === "deny"),
  };
}

/** How many permissions differ from what the entry had when the dialog opened. */
export function changedCount(initial: { allow: string[]; deny: string[] }, draft: Draft): number {
  const before = draftOf(initial);
  const names = new Set([...Object.keys(before), ...Object.keys(draft)]);
  let count = 0;
  for (const name of names) if (stateOf(before, name) !== stateOf(draft, name)) count += 1;
  return count;
}

const ORDER = ["read", "contribute", "manage"] as const;

/**
 * Permissions the editor cannot set, with the reason. The API says which permissions of the family
 * the editor holds on the resource (`may.held`): exactly the others are locked (rule 2: nobody
 * grants or denies what they do not have). A guest never takes the manage permissions, whatever the
 * editor holds, and that reason wins.
 */
export function locksOf(kind: Kind, held: string[], guest: boolean): Record<string, LockReason> {
  const locks: Record<string, LockReason> = {};
  GROUPS[kind].forEach((g, i) => {
    for (const permission of g.permissions) {
      if (guest && ORDER[i] === "manage") locks[permission] = "guest";
      else if (!held.includes(permission)) locks[permission] = "not_held";
    }
  });
  return locks;
}

/**
 * Whether an entry offers "Personnaliser". Lines that take levels only (the system roles' bits live
 * in the legacy settings) do not: everyone and the guests of a channel, the members of a calendar,
 * and the Administrator role on both. Files take it everywhere. A channel's readers never do.
 */
export function canCustomise(kind: Kind, entry: { target: { kind: string }; guest: boolean }, isAdministratorRole: boolean): boolean {
  const { target } = entry;
  if (target.kind === "audience") return false;
  if (kind === "file") return true;
  if (target.kind === "role" && isAdministratorRole) return false;
  // The members line and the guests line are both `everyone`; the entry's `guest` tells them apart.
  if (target.kind === "everyone") return kind === "calendar" && entry.guest;
  return true;
}

/** "Participer, sauf Mentionner tout le monde": the preset the entry is nearest to, and its differences. */
export function resultOf(
  kind: Kind,
  nearest: Level,
  draft: Draft,
): { level: "read" | "contribute" | "manage"; except: string[]; plus: string[] } {
  const level = nearest === "contribute" || nearest === "manage" ? nearest : "read";
  const upTo = ORDER.indexOf(level);
  const inLevel = new Set(GROUPS[kind].slice(0, upTo + 1).flatMap((g) => g.permissions));
  const names = catalogue(kind);
  return {
    level,
    except: names.filter((n) => draft[n] === "deny" && inLevel.has(n)),
    plus: names.filter((n) => draft[n] === "allow" && !inLevel.has(n)),
  };
}

/**
 * The option a key moves to inside a radio group (the WAI-ARIA pattern): arrows move and wrap, Home
 * and End jump. `undefined` for any other key, so the browser keeps it (Tab leaves the group).
 */
export function nextRadio(key: string, index: number, count: number): number | undefined {
  if (count <= 0) return undefined;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return (index + 1) % count;
    case "ArrowLeft":
    case "ArrowUp":
      return (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return undefined;
  }
}
