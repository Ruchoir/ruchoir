/**
 * What the Access dialog decides without drawing anything: which levels a viewer may pick for a
 * line, what a line says about itself, how the lines are ordered. The API decides what is allowed
 * (`may` block, refusals); this only offers what it would accept and says why the rest is off.
 * Dictionary keys are plain strings here so the tests need no dictionary.
 */

export type Kind = "channel" | "file" | "calendar";
export type Level = "none" | "read" | "contribute" | "manage" | "custom";
type TargetKind = "everyone" | "role" | "group" | "user" | "audience";

/** An entry as these helpers read it (`AccessEntry` from the client, the fields used here). */
export type EntryLike = {
  id?: string;
  target: { kind: TargetKind; id?: string; name?: string; hidden: boolean };
  level: Level;
  allow: string[];
  deny: string[];
  clamped: boolean;
  guest: boolean;
  inheritedFrom?: { kind: string; id?: string; name?: string; hidden: boolean };
  summary?: { nearest: Level; changes: { permission: string; state: "allow" | "deny" | "unset" }[] };
  viaLegacy: boolean;
  setBy?: { id: string; name: string };
};

export type MayLike = { edit: boolean; fine: boolean; manageTargetLevels: Level[]; reason?: string };
export type AccessLike = { archived: boolean; may: MayLike };

/** Why a level cannot be picked: a guest's ceiling, the caller's own line, a level they do not hold. */
export type OffReason = "guest" | "self" | "not_held";
export type LevelOption = { level: Level; disabled?: boolean; reason?: OffReason };

const RANK: Record<Level, number> = { none: 0, read: 1, contribute: 2, manage: 3, custom: -1 };

/** The label of a level: the middle one is named after what the resource allows (write, edit, take part). */
export function levelLabelKey(kind: Kind, level: Level): string {
  if (level === "contribute") return `access.level.${kind}.contribute`;
  return `access.level.${level}`;
}

/** The one-line meaning of a preset level for a kind of resource. */
export function levelDescKey(kind: Kind, level: Exclude<Level, "none" | "custom">): string {
  return `access.levelDesc.${kind}.${level}`;
}

/** The levels a line's selector offers. The current one is always listed, even when it is off. */
export function levelOptions(may: MayLike, entry: EntryLike, meId: string | undefined): LevelOption[] {
  const self = entry.target.kind === "user" && entry.target.id !== undefined && entry.target.id === meId;
  const out: LevelOption[] = [];
  for (const level of ["none", "read", "contribute", "manage"] as const) {
    const offered = may.manageTargetLevels.includes(level) && (level !== "none" || entry.target.kind === "everyone");
    if (!offered && entry.level !== level) continue;
    const option: LevelOption = { level };
    if (self) {
      option.disabled = true;
      option.reason = "self";
    } else if (level === "manage" && entry.guest) {
      option.disabled = true;
      option.reason = "guest";
    } else if (!offered) {
      option.disabled = true;
      option.reason = "not_held";
    }
    out.push(option);
  }
  if (entry.level === "custom") out.push({ level: "custom", disabled: true });
  return out;
}

/** The same for the add dialog: one level for the whole selection, Manage greyed when a guest is in it. */
export function addLevelOptions(may: MayLike, picked: { kind: string; guest: boolean }[]): LevelOption[] {
  const guest = picked.some((p) => p.guest);
  return (["read", "contribute", "manage"] as const)
    .filter((level) => may.manageTargetLevels.includes(level))
    .map((level) => (level === "manage" && guest ? { level, disabled: true, reason: "guest" as const } : { level }));
}

/** Whether a line has a remove button: never Everyone, the caller's own line, an inherited or legacy one. */
export function removable(entry: EntryLike, meId: string | undefined): boolean {
  if (!entry.id || entry.inheritedFrom || entry.viaLegacy) return false;
  if (entry.target.kind === "everyone") return false;
  if (entry.target.kind === "user" && entry.target.id === meId) return false;
  return true;
}

export type EntryNote =
  | { type: "atLeast"; level: Level }
  | { type: "deny" }
  | { type: "custom"; nearest: Level; mode: "except" | "plus" | "changes"; count: number }
  | { type: "clamped" }
  | { type: "inherited"; folder?: string };

/** What a line says beside its name, when it has something to say. */
export function entryNote(entry: EntryLike, entries: EntryLike[]): EntryNote | undefined {
  if (entry.inheritedFrom) return { type: "inherited", folder: entry.inheritedFrom.hidden ? undefined : entry.inheritedFrom.name };
  if (entry.level === "custom" && entry.summary) {
    const states = entry.summary.changes.map((c) => c.state);
    const mode = states.every((s) => s === "allow") ? "plus" : states.every((s) => s !== "allow") ? "except" : "changes";
    return { type: "custom", nearest: entry.summary.nearest, mode, count: states.length };
  }
  if (entry.level === "none" && entry.target.kind !== "everyone") return { type: "deny" };
  if (entry.clamped) return { type: "clamped" };
  if (entry.target.kind !== "everyone" && entry.level !== "custom" && entry.level !== "none") {
    // A guest's floor is the guests line; a member's, the members line.
    const base = entries.find((e) => everyoneLine(e) === (entry.guest ? "guests" : "members") && !e.inheritedFrom);
    if (base && base.level !== "custom" && RANK[base.level] > RANK[entry.level]) return { type: "atLeast", level: base.level };
  }
  return undefined;
}

/**
 * Which "everyone" line this is. Both are `everyone` on the wire and name their base role by UUID, so
 * the entry's `guest` flag (true on the guests line) is what tells them apart.
 */
export function everyoneLine(entry: EntryLike): "members" | "guests" | undefined {
  if (entry.target.kind !== "everyone") return undefined;
  return entry.guest ? "guests" : "members";
}

/**
 * The read-only dialog of someone who manages a resource in a free space (frame 11): the level gives
 * its own rights, but changing who has access is the Enterprise edition's. Not for an archived item
 * nor a frozen licence, which have their own sentences.
 */
export function freeManage(
  access: { archived: boolean; may: { edit: boolean; reason?: string } },
  kind: Kind,
  isFolder: boolean,
): { lead: string; detail: string; cta: string } | undefined {
  if (access.archived || access.may.edit || access.may.reason !== "licence_required") return undefined;
  const what = kind === "file" && isFolder ? "folder" : kind;
  // A folder and a file read the same in the body (what a manager may do), so they share it.
  return { lead: `access.freeManage.title.${what}`, detail: `access.freeManage.body.${kind}`, cta: `access.freeManage.upsell.${what}` };
}

/** Who to ask to change the access: the owner, then the administrators, three at most. */
export function askWho(members: { name: string; role: string; bot?: boolean }[]): string[] {
  const people = members.filter((m) => !m.bot);
  return [...people.filter((m) => m.role === "owner"), ...people.filter((m) => m.role === "admin")].slice(0, 3).map((m) => m.name);
}

/** Who wrote an entry's rule: the viewer ("Ajoutée par vous"), somebody else ("<Nom> le lui a donné"), or nobody known. */
export function authorNote(entry: EntryLike, viewerId: string | undefined): { type: "you" } | { type: "other"; name: string } | undefined {
  // An inherited line was set on the folder above: the giver is not this item's to name.
  if (!entry.setBy || entry.inheritedFrom) return undefined;
  if (viewerId !== undefined && entry.setBy.id === viewerId) return { type: "you" };
  return { type: "other", name: entry.setBy.name };
}

/** The viewer's own line, which the dialog tags "Vous". */
export function isYou(entry: EntryLike, viewerId: string | undefined): boolean {
  return viewerId !== undefined && entry.target.kind === "user" && entry.target.id === viewerId;
}

/**
 * The intro of a local manager's dialog (frame 10): with the paid edition, somebody who holds Gérer
 * here through their own line sets the access of others within their own rights. The dictionary key,
 * or nothing. The wire does not say who gave the level, so the sentence does not name a giver.
 */
export function delegationIntro(
  access: { archived: boolean; may: { edit: boolean; fine: boolean }; entries: EntryLike[] },
  viewerId: string | undefined,
  kind: Kind,
  isFolder: boolean,
): string | undefined {
  if (access.archived || !access.may.edit || !access.may.fine) return undefined;
  if (!access.entries.some((e) => isYou(e, viewerId) && e.level === "manage")) return undefined;
  return `access.delegation.${kind === "file" && isFolder ? "folder" : kind}`;
}

/** The folders above an item, outermost first, as one path ("Compta / 2026"); nothing at the top. */
export function fullPath(folders: string[]): string | undefined {
  return folders.length > 0 ? folders.join(" / ") : undefined;
}

export function canEdit(access: AccessLike): boolean {
  return access.may.edit && !access.archived;
}

/** Why the dialog is read-only, as a dictionary key; nothing when it is not. */
export function readOnlyReason(access: AccessLike, kind: Kind = "channel"): string | undefined {
  if (access.archived) return kind === "channel" ? "access.readOnly.archived" : "access.readOnly.trashed";
  if (access.may.edit) return undefined;
  switch (access.may.reason) {
    case "licence_required":
      return "access.readOnly.licenceRequired";
    case "licence_frozen":
      return "access.readOnly.licenceFrozen";
    default:
      return "access.readOnly.notAllowed";
  }
}

/** The note of a private channel: who has just been given sight of it. Nothing when nobody was. */
export function privateNote(isPrivate: boolean, addedNames: string[]): { names: string[] } | undefined {
  return isPrivate && addedNames.length > 0 ? { names: addedNames } : undefined;
}

const ORDER: Record<TargetKind, number> = { everyone: 0, role: 1, audience: 2, group: 3, user: 4 };

/**
 * The lines in the order the dialog shows them (frame 7): everyone, roles, the readers of a channel,
 * groups, people. One list: a line set here that overrides an inherited one takes its place.
 */
export function groupEntries<E extends EntryLike>(entries: E[]): E[] {
  const key = (e: E) => ORDER[e.target.kind];
  return entries.map((e, i) => ({ e, i })).sort((a, b) => key(a.e) - key(b.e) || a.i - b.i).map((x) => x.e);
}

/** Whether a line may be changed here: the viewer may edit, the item is live, and the line is its own. */
export function entryEditable(access: AccessLike, entry: EntryLike): boolean {
  return canEdit(access) && !entry.inheritedFrom;
}

/** The folder an inherited line comes from, when the viewer may open it; nothing for a hidden one. */
export function inheritedLink(entry: EntryLike): { id: string; name: string } | undefined {
  const from = entry.inheritedFrom;
  if (!from || from.hidden || !from.id) return undefined;
  return { id: from.id, name: from.name ?? "" };
}

/** What a line of the item replaces: the level its target had from above, and the folder it came from. */
export type Override = { level: Level; folder?: string };

const targetId = (e: EntryLike) => `${e.target.kind}:${e.target.id ?? ""}`;

/**
 * The lines of a file or folder, with what each of its own lines replaces. The nearest rule wins
 * (the server already lists one line per target); `parent` is what the parent folder's dialog
 * lists, which is exactly what the item would inherit. A line of the item's own for a target the
 * parent also has is an override, and drops the inherited line for that target should one remain.
 * Without the parent's view nothing is claimed.
 */
export function withOverrides<E extends EntryLike>(
  entries: E[],
  parent: EntryLike[] | undefined,
  parentName: string | undefined,
): { entries: E[]; overrides: Map<string, Override> } {
  const overrides = new Map<string, Override>();
  if (!parent) return { entries, overrides };
  const own = new Set(entries.filter((e) => !e.inheritedFrom && e.id).map(targetId));
  for (const line of parent) {
    const key = targetId(line);
    if (!own.has(key) || overrides.has(key)) continue;
    overrides.set(key, { level: line.level, folder: line.inheritedFrom ? (line.inheritedFrom.hidden ? undefined : line.inheritedFrom.name) : parentName });
  }
  return { entries: entries.filter((e) => !e.inheritedFrom || !own.has(targetId(e))), overrides };
}

/** The level the legacy "who may write" setting of a space calendar stood for: members write, admins only read. */
export function calendarLevelOf(writeAccess: "members" | "admins"): Level {
  return writeAccess === "members" ? "contribute" : "read";
}
