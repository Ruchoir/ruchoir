/**
 * What the sharing screens decide without drawing anything (the web's access dialog, "Personnaliser"
 * and "Pourquoi ?", read on the phone): the order of the lines with an override in place, what each
 * line says about itself, the rows of a level sheet, the customise draft and its payload, whether the
 * customise row is open, locked (community edition) or absent, and the cards that explain an access.
 * The shared logic (`@ruchoir/client/permissionsLogic`) holds the rules; the API is the judge of every
 * write. Dictionary keys are plain strings and `say` is the translator, so the tests need no dictionary.
 * Pure, tested by Node.
 */
import {
  addLevelOptions,
  alreadyVia,
  askWho,
  canCustomise,
  canEdit,
  cardsOf,
  changedCount,
  customiseGroupsOf,
  delegationIntro,
  draftOf,
  entryEditable,
  entryNote,
  freeManage,
  groupEntries,
  isYou,
  joinSentences,
  levelDescKey,
  levelLabelKey,
  levelOptions,
  levelWordKey,
  locksOf,
  outline,
  privateNote,
  reasonKey,
  removable,
  resultOf,
  ruleOf,
  stateOf,
  stepSentence,
  withOverrides,
  type AccessLike,
  type ChainLevel,
  type CustomiseKind,
  type Draft,
  type EntryLike,
  type Kind,
  type LevelOption,
  type LockReason,
  type MayLike,
  type OffReason,
  type Override,
  type ResultLike,
  type State,
  type StepGroup,
  type StepLike,
  type WhyRoleLike,
} from "@ruchoir/client/permissionsLogic";

type Say = (key: string, vars?: Record<string, string | number>) => string;

const targetKey = (target: { kind: string; id?: string }) => `${target.kind}:${target.id ?? ""}`;

/** The lines in the order the screen shows them; a line of the item's own for a target the folder above also has is an override. */
export function entryRows<E extends EntryLike>(entries: E[], parent: { entries: EntryLike[]; name?: string } | undefined): { entry: E; override?: Override }[] {
  const merged = withOverrides(entries, parent?.entries, parent?.name);
  return groupEntries(merged.entries).map((entry) => ({ entry, override: entry.inheritedFrom ? undefined : merged.overrides.get(targetKey(entry.target)) }));
}

/** The same line across a read: the item's own for that target, else the inherited one. */
export function findEntry<E extends EntryLike>(entries: E[], target: { kind: string; id?: string }): E | undefined {
  const same = entries.filter((e) => e.target.kind === target.kind && (e.target.id ?? "") === (target.id ?? ""));
  return same.find((e) => !e.inheritedFrom) ?? same[0];
}

/** A line of the "who has access" list, in the order of its parts: who it is, then what limits it. */
export function entryLine(
  say: Say,
  entry: EntryLike,
  entries: EntryLike[],
  ctx: { viewerId: string | undefined; kind: Kind; /** A person's title. */ title?: string; /** A group's head count. */ people?: number; customRole?: boolean; override?: Override },
): string[] {
  const parts: string[] = [];
  const { target } = entry;
  if (target.kind === "everyone") parts.push(say(entry.guest ? "access.allGuestsSub" : "access.everyoneSub"));
  else if (target.kind === "role") parts.push(say(ctx.customRole ? "access.customRoleSub" : "spaceAdmin.role"));
  else if (target.kind === "group") {
    if (ctx.people !== undefined) parts.push(say("compose.groupLine", { count: ctx.people }));
  } else if (target.kind === "audience") parts.push(say("access.audienceSub"));
  else if (isYou(entry, ctx.viewerId)) parts.push(say("spaceAdmin.you"));
  else if (ctx.title) parts.push(ctx.title);
  if (entry.guest && target.kind !== "everyone") parts.push(say("invite.guest"));

  const note = entryNote(entry, entries);
  if (ctx.override) {
    const level = say(levelLabelKey(ctx.kind, ctx.override.level));
    parts.push(ctx.override.folder ? say("access.overrides", { level, folder: ctx.override.folder }) : say("access.overridesHidden", { level }));
  } else if (note?.type === "atLeast") parts.push(say("access.atLeast", { level: say(levelLabelKey(ctx.kind, note.level)) }));
  else if (note?.type === "deny") parts.push(say("access.denyNote"));
  else if (note?.type === "custom") {
    const level = say(levelLabelKey(ctx.kind, note.nearest));
    const key = note.mode === "except" ? "access.customExcept" : note.mode === "plus" ? "access.customPlus" : "access.customChanges";
    parts.push(say(key, { level, count: note.count }));
  } else if (note?.type === "clamped") parts.push(say(target.kind === "user" ? "access.guestLimited" : "access.clamped"));
  else if (note?.type === "inherited") parts.push(note.folder ? say("access.inheritedFrom", { folder: note.folder }) : say("access.inheritedHidden"));

  if (!entry.inheritedFrom && entry.setBy && !(ctx.viewerId !== undefined && entry.setBy.id === ctx.viewerId)) parts.push(say("access.givenBy", { name: entry.setBy.name }));
  return parts;
}

export type LevelRow = {
  id: "none" | "read" | "contribute" | "manage" | "custom" | "remove";
  titleKey: string;
  descKey?: string;
  selected: boolean;
  disabled?: boolean;
  /** Why the row cannot be picked, as a dictionary key. */
  reasonKey?: string;
  /** What picking it does: give the level, take the line away, or open "Personnaliser". */
  effect: "set" | "remove" | "customise";
};

const OFF_KEY: Record<OffReason, string> = { guest: "access.guestCap", self: "access.selfLocked", not_held: "access.levelNotHeld" };

function rowOf(kind: Kind, option: LevelOption, selected: boolean): LevelRow {
  const { level } = option;
  const row: LevelRow = {
    id: level,
    titleKey: levelLabelKey(kind, level),
    selected,
    effect: level === "custom" ? "customise" : "set",
  };
  if (level === "none") row.descKey = "access.reserveHint";
  else if (level === "custom") row.descKey = "access.customiseHint";
  else row.descKey = levelDescKey(kind, level);
  if (option.disabled) row.disabled = true;
  if (option.reason) row.reasonKey = OFF_KEY[option.reason];
  return row;
}

/**
 * The rows of one line's level sheet: Aucun accès (which takes a person's, a group's or a role's line
 * away, and reserves on the base line), the presets the viewer may give, and Personnalisé. A level that
 * cannot be given says why. The API still judges; this offers what it would accept.
 */
export function levelRows(kind: Kind, may: MayLike, entry: EntryLike, meId: string | undefined, ctx: { editable: boolean; customise: "open" | "locked" | "hidden" }): LevelRow[] {
  const rows = levelOptions(may, entry, meId).map((option) => rowOf(kind, option, option.level === entry.level));
  if (ctx.customise === "open") {
    const own = rows.find((row) => row.id === "custom");
    if (own) {
      own.disabled = undefined;
      own.reasonKey = undefined;
    } else rows.push(rowOf(kind, { level: "custom" }, false));
  }
  if (ctx.editable && removable(entry, meId)) rows.unshift({ id: "remove", titleKey: "access.level.none", descKey: "access.removeLineHint", selected: false, effect: "remove" });
  return rows;
}

/** The levels of the adding sheet: one for the whole selection, Gérer greyed when a guest is in it. */
export function addRows(kind: Kind, may: MayLike, picked: { kind: string; guest: boolean }[]): LevelRow[] {
  return addLevelOptions(may, picked).map((option) => rowOf(kind, option, false));
}

/**
 * Whether "Personnaliser" is offered on a line: open when the edition allows it, locked (the Entreprise
 * lock) in a community space, absent where the line takes levels only or the viewer may not edit it.
 */
export function customiseDecision(kind: Kind, access: AccessLike, entry: EntryLike, isAdministratorRole: boolean): "open" | "locked" | "hidden" {
  if (!canEdit(access) || !entryEditable(access, entry)) return "hidden";
  if (!canCustomise(kind, entry, isAdministratorRole)) return "hidden";
  return access.may.fine ? "open" : "locked";
}

/** The line the locked "Personnaliser les droits de X" row speaks of: the first that would have had it. */
export function communityLock<E extends EntryLike>(kind: Kind, access: AccessLike, entries: E[], administratorRoleIds: Set<string>): E | undefined {
  return entries.find((entry) => customiseDecision(kind, access, entry, entry.target.kind === "role" && administratorRoleIds.has(entry.target.id ?? "")) === "locked");
}

export type CustomiseRow = { permission: string; state: State; edited: boolean; lock?: LockReason };

/** The customise screen as data: its rows by family, how many rights changed, the result line and what is sent. */
export function customiseView(kind: CustomiseKind, entry: Pick<EntryLike, "allow" | "deny" | "guest" | "level" | "summary">, held: string[], draft: Draft) {
  const locks = locksOf(kind, held, entry.guest);
  const before = draftOf(entry);
  const families = customiseGroupsOf(kind).map((family) => ({
    group: family.group,
    rows: family.permissions.map((permission): CustomiseRow => {
      const state = stateOf(draft, permission);
      return { permission, state, edited: state !== stateOf(before, permission), lock: locks[permission] };
    }),
  }));
  return {
    families,
    changed: changedCount(entry, draft),
    result: resultOf(kind, entry.summary?.nearest ?? entry.level, draft),
    payload: ruleOf(kind, draft),
  };
}

/** The head of the screen: what is shared, as the web's dialog titles it. */
export function titleOf(kind: Kind, isFolder: boolean, name: string): { key: string; vars: Record<string, string> } {
  if (kind === "channel") return { key: "access.title", vars: { name: `#${name}` } };
  if (kind === "calendar") return { key: "access.shareCalendarTitle", vars: { name } };
  if (isFolder) return { key: "access.shareFolderTitle", vars: { name } };
  return { key: "files.shareTitle", vars: { name } };
}

type ViewLike = { private: boolean; archived: boolean; entries: EntryLike[]; may: MayLike; resource: { parent?: { id?: string; name?: string; hidden: boolean } } };

/** The line under the title: what the screen is about, for the kind of thing and what the viewer may do. */
export function subtitleOf(kind: Kind, isFolder: boolean, view: ViewLike | null, viewerId: string | undefined): { key: string; vars: Record<string, string> } {
  if (view && freeManage(view, kind, isFolder)) return { key: "access.freeManage.subtitle", vars: {} };
  const delegation = view ? delegationIntro(view, viewerId, kind, isFolder) : undefined;
  if (delegation) return { key: delegation, vars: {} };
  if (kind === "calendar") return { key: "access.subtitleCalendar", vars: {} };
  if (kind === "file") {
    const parent = view?.resource.parent;
    const name = parent && !parent.hidden ? parent.name : undefined;
    if (name) return { key: isFolder ? "access.subtitleFolderIn" : "access.subtitleFileIn", vars: { parent: name } };
    return { key: isFolder ? "access.subtitleFolder" : "access.subtitleFile", vars: {} };
  }
  if (view?.may.fine) return { key: "access.subtitleEnterprise", vars: {} };
  return { key: view?.private ? "access.subtitlePrivate" : "access.subtitle", vars: {} };
}

/** Who to ask when the viewer may only read: the owner, then administrators, as a sentence. */
export function askLine(say: Say, people: { name: string; role: string; bot?: boolean }[], or: string): string {
  const asked = askWho(people);
  if (asked.length === 0) return say("access.freeManage.noNames");
  if (asked.length === 1) return asked[0]!;
  return `${asked.slice(0, -1).join(", ")} ${or} ${asked[asked.length - 1]}`;
}

// --- "Pourquoi ?" ---

type WhyLike = { person: { id?: string; name: string; roles?: WhyRoleLike[] }; steps: StepLike[]; result: ResultLike[] };
type Ref = { kind: string; id?: string; name?: string; hidden: boolean };

export type WhyDeps = {
  say: Say;
  kind: Kind;
  /** The item explained is a folder (folders and files are both `file` on the wire). */
  isFolder: boolean;
  person: string;
  locale: string;
  permissionName: (permission: string) => string;
  list: (names: string[]) => string;
  /** A target or a role as the screen names it ("Tout l'espace", "Administrateur"); `hidden` when it has no name. */
  roleName: (ref: Ref | undefined, hidden: string) => string;
};

export type WhyCard = { type: "base" | "roles" | "space" | "level" | "locks" | "quiet" | "other"; label: string; body: string };

const capital = (text: string, locale: string) => (text ? text.charAt(0).toLocaleUpperCase(locale) + text.slice(1) : text);

/** "Plafond des invités : Thomas a le statut..." as a label and its sentence; a sentence with no lead keeps no label. */
function leadOf(text: string, locale: string): { label: string; body: string } {
  const at = text.indexOf(":");
  return at < 0 ? { label: "", body: text } : { label: text.slice(0, at).trim(), body: capital(text.slice(at + 1).trim(), locale) };
}

/**
 * The explanation as cards, in the order the engine works it: the base role, the roles held and the
 * groups carrying them, what those roles give in the space, one card per level of the chain with its
 * rules, then the locks (private, guest ceiling, owner, archive). Every step the API gives is in one.
 */
export function whyCards(deps: WhyDeps, why: WhyLike, chain: ChainLevel[]): WhyCard[] {
  const { say, locale, person } = deps;
  if (why.steps.length === 0) return [];
  const names = (permissions: string[]) => deps.list(permissions.map(deps.permissionName));
  const fill = (group: StepGroup) => {
    const sentence = stepSentence(group);
    const role = group.role ? deps.roleName({ kind: "role", id: group.role.id, name: group.role.name, hidden: false }, group.role.name) : undefined;
    return say(sentence.key, {
      ...sentence.values,
      ...(role ? { role } : {}),
      where: sentence.values.where || say("why.hiddenPlace"),
      target: deps.roleName(group.target, say("why.hiddenTarget")),
      person,
      permission: names(group.permissions),
    });
  };
  const cards: WhyCard[] = [];
  for (const para of outline(why.steps, chain, why.person.roles)) {
    switch (para.type) {
      case "base":
        cards.push({ type: "base", label: say("why.label.base"), body: capital(say(para.group.effect === "removed" ? "why.para.base.removed" : "why.para.base.granted", { permission: names(para.group.permissions), person }), locale) });
        break;
      case "roles": {
        const parts = para.roles.map((role) => {
          const groups = role.viaGroups.map((g) => g.name);
          const how = groups.length === 0 ? say("why.para.viaDirect") : say(role.direct ? "why.para.viaBoth" : "why.para.viaGroup", { groups: groups.join(", ") });
          return `${deps.roleName({ kind: "role", id: role.id, name: role.name, hidden: false }, role.name)} ${how}`;
        });
        cards.push({ type: "roles", label: say("why.label.roles"), body: `${parts.join(", ")}.` });
        break;
      }
      case "space": {
        const role = deps.roleName({ kind: "role", id: para.role.id, name: para.role.name, hidden: false }, para.role.name);
        cards.push({ type: "space", label: say("why.label.space"), body: say(para.effect === "removed" ? "why.para.space.removed" : "why.para.space.granted", { role, permission: names(para.permissions) }) });
        break;
      }
      case "level": {
        const wordKey = levelWordKey(para, deps.kind, deps.isFolder);
        const word = wordKey ? say(wordKey) : "";
        const label = para.hidden ? say("why.label.hiddenPlace") : `${word} ${deps.kind === "channel" && para.item ? "#" : ""}${para.name ?? ""}`.trim();
        if (para.rules.length === 0) {
          cards.push({ type: "level", label, body: capital(say("why.para.level.none", { person }), locale) });
          break;
        }
        const body = para.rules.map((g) => {
          const target = deps.roleName(g.target, say("why.hiddenTarget"));
          const permission = names(g.permissions);
          if (g.effect === "removed") return say("why.para.rule.removed", { permission, target, person });
          if (!g.ruleLevel) return say("why.para.rule.grantedNoLevel", { permission, target, person });
          const levelKind = g.level?.kind === "channel" || g.level?.kind === "calendar" ? g.level.kind : "file";
          return say("why.para.rule.granted", { level: say(levelLabelKey(levelKind, g.ruleLevel)), target, person, permission, count: g.permissions.length });
        });
        cards.push({ type: "level", label, body: capital(joinSentences(body, locale), locale) });
        break;
      }
      case "locks":
        for (const g of para.groups) cards.push({ type: "locks", ...leadOf(fill(g), locale) });
        break;
      case "quiet":
        cards.push({ type: "quiet", ...leadOf(say("why.locksNone"), locale) });
        break;
      case "other":
        cards.push({ type: "other", ...leadOf(fill(para.group), locale) });
        break;
    }
  }
  return cards;
}

/** The decision for each level of rights, and the step that decided it. */
export function resultRows(say: Say, kind: Kind, why: Pick<WhyLike, "steps" | "result">): { id: string; granted: boolean; label: string; reason: string }[] {
  return cardsOf(kind, why.result, why.steps).map((card) => {
    const { reason } = card;
    const text = reason?.levelKey
      ? reason.hiddenPlace
        ? say("why.reason.ruleOnHidden", { level: say(reason.levelKey) })
        : say("why.reason.ruleOn", { where: reason.where ?? "", level: say(reason.levelKey) })
      : reason
        ? say(reasonKey(reason.kind))
        : card.granted
          ? say("why.reason.other")
          : card.hint === "askManage"
            ? say("why.reason.askManage")
            : say("why.reason.none");
    return { id: card.id, granted: card.granted, label: say(card.labelKey), reason: text };
  });
}

/** The permission that means "can see it", per kind of resource: what "already has access through ..." reads. */
const VIEW_PERMISSION: Record<Kind, string> = { channel: "channel.view", file: "files.view", calendar: "calendar.view" };

/** Who the add picker asks "how do they already have access?": a short list only, each person being one explanation. */
export function viaAsks(people: { userId: string }[]): string[] {
  return people.length <= 6 ? people.map((p) => p.userId) : [];
}

/** What a person already reaches the item through (a group, a role), from the "Pourquoi ?" answer; undefined when nothing names it. */
export function viaNote(why: Parameters<typeof alreadyVia>[0], kind: Kind): string | undefined {
  return alreadyVia(why, VIEW_PERMISSION[kind]);
}

/** The three preset levels with what each means for the kind, the footer of the access screen (the web's). */
export function levelGlossary(kind: Kind): { label: string; desc: string }[] {
  return (["read", "contribute", "manage"] as const).map((level) => ({ label: levelLabelKey(kind, level), desc: levelDescKey(kind, level) }));
}

/** The note of a private channel after people were added: those just added who are still on its list. */
export function privateNoteFor(view: { private: boolean; entries: { target: { kind: string; id?: string } }[] }, added: { key: string; name: string }[]): { names: string[] } | undefined {
  const listed = new Set(view.entries.map((e) => targetKey(e.target)));
  return privateNote(view.private, added.filter((a) => listed.has(a.key)).map((a) => a.name));
}

/** The people whose access can be checked: everyone but the bots. */
export function verifyPeople<M extends { bot?: boolean }>(members: M[]): M[] {
  return members.filter((m) => !m.bot);
}
