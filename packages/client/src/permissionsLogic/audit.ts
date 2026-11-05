/**
 * What the Journal tab says about each line of a space's audit log, apart from drawing it: which
 * sentence, who and what fill it, and the rights or roles added and taken away. The screen maps
 * each sentence to its dictionary key; nothing here reads a translation.
 */

import { chipsFor, type Figure, reportLink, sourceLabel } from "./imports.ts";
import { daysLeft } from "./guests.ts";

/** An entry as the client reads it (`AuditEntry`, the fields used here). */
export type EntryLike = {
  at: string;
  action: string;
  actor?: { id: string; name: string };
  target: { kind: string; id?: string; label?: string };
  details: Record<string, unknown>;
};

export type Slot =
  | { kind: "person"; name: string }
  | { kind: "deleted" }
  /** A group, drawn with the users icon. */
  | { kind: "group"; name: string; id?: string }
  /** People named by id; `null` is a person no longer in the space (the account may well exist). */
  | { kind: "people"; names: (string | null)[] }
  | { kind: "role"; name: string; colour?: string }
  /** Everyone: the members, or the guests. */
  | { kind: "everyone"; guests: boolean }
  /** The readers of a channel (a rule on a file). */
  | { kind: "audience" }
  /** What a rule is on: a channel, a file or folder, a calendar. */
  | { kind: "resource"; of: "channel" | "file" | "calendar"; name: string; bare?: boolean }
  | { kind: "legacy"; roles: string[] };

/** The families of the journal, in the order the filter lists them (the API's `category` values). */
export const AUDIT_CATEGORIES = ["members", "roles", "groups", "channels", "calendars", "licence", "guests", "access"] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

/** The family a line is filed under: the API's, or members for one this app does not know. */
export function lineCategory(entry: { category: string; action: string }): AuditCategory {
  return (AUDIT_CATEGORIES as readonly string[]).includes(entry.category) ? (entry.category as AuditCategory) : "members";
}

export type Sentence =
  | "memberJoined"
  | "memberJoinedGuest"
  | "memberLeft"
  | "memberRemoved"
  | "memberIssuedRevoked"
  | "memberRoleChanged"
  | "ownershipTransferred"
  | "memberRolesChanged"
  | "roleCreated"
  | "roleUpdated"
  | "roleRenamed"
  | "roleDeleted"
  | "rolesReordered"
  | "channelReserved"
  | "channelOpened"
  | "calendarWriteMembers"
  | "calendarWriteAdmins"
  | "groupCreated"
  | "groupRenamed"
  | "groupDescribed"
  | "groupDeleted"
  | "groupDeletedBare"
  | "groupMembersAdded"
  | "groupMembersRemoved"
  | "groupRolesChanged"
  | "groupManagersAdded"
  | "groupManagersRemoved"
  | "groupManagersChanged"
  | "ruleCreated"
  | "ruleUpdated"
  | "ruleCustomised"
  | "ruleDeleted"
  | "ruleReserved"
  | "rolePreviewStarted"
  | "rolePreviewEnded"
  | "licenceInstalled"
  | "licenceRemoved"
  | "guestExpiryFixed"
  | "guestExpiryMoved"
  | "guestExpiryExtended"
  | "guestExpiryAdvanced"
  | "guestExpiryRemoved"
  | "guestExpired"
  | "guestReactivated"
  | "guestToMember"
  | "memberToGuest"
  | "guestPurged"
  | "importApplied"
  | "unknown";

export type AuditLine = {
  sentence: Sentence;
  /** Who and what, drawn as a name or a pastille. Always `actor`. */
  slots: Record<string, Slot>;
  /** Plain values: a channel's or calendar's name, seats, a date (ISO 8601), the action. */
  values: Record<string, string | number>;
  /** `viaGroup`: the roles come with a group, so each chip says "by the group". */
  diff?: { kind: "permission" | "role" | "level"; added: string[]; removed: string[]; viaGroup?: boolean };
  /** The pastilles of a guest line: the standing taken or left, the access ended, a date. */
  chips?: { sign: "+" | "-"; what: "member" | "guest" | "until" | "space"; date?: string }[];
  /** An import's figures, one pastille each (zero ones left out). */
  figures?: Figure[];
  /** The job an import line points at, for "Ouvrir le rapport". */
  report?: string;
};

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

/** `[{ id, name }]` as the log keeps a member's roles. */
function named(value: unknown): { id: string; name: string }[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is { id: unknown; name: unknown } => typeof v === "object" && v !== null)
    .map((v) => ({ id: str(v.id), name: str(v.name) }));
}

function both(before: string[], after: string[]) {
  return { added: after.filter((x) => !before.includes(x)), removed: before.filter((x) => !after.includes(x)) };
}

/** Who the user ids of a group line are, as the members list knows them (undefined: gone). */
export type NameOf = (userId: string) => string | undefined;

/** What the log keeps as ids for a rule's target: groups and roles are named from the space's lists. */
export type Refs = {
  group: NameOf;
  role: (id: string) => { name: string; systemKey?: string } | undefined;
};

/** A rule's level as the log words it: a level name, `{ allow, deny }` for a custom one, or null. */
type Shown = string | { allow?: unknown; deny?: unknown } | null | undefined;

function ruleLine(entry: EntryLike, nameOf: NameOf, refs: Refs | undefined, line: (sentence: Sentence, extra?: Partial<AuditLine>) => AuditLine): AuditLine {
  const d = entry.details ?? {};
  const kind = entry.target.kind === "file" || entry.target.kind === "calendar" ? entry.target.kind : "channel";
  const id = str(d.target_id);
  // The names the log kept that day win; a null one falls back to today's lists, then to nothing
  // (the screen says "une personne", "un canal"...).
  const snapshot = str(d.target_name);
  let target: Slot;
  let reserved = false;
  switch (str(d.target_kind)) {
    case "group":
      target = { kind: "group", name: snapshot || refs?.group(id) || "", id };
      break;
    case "role":
      target = { kind: "role", name: snapshot || refs?.role(id)?.name || "" };
      break;
    case "everyone":
      target = { kind: "everyone", guests: refs?.role(id)?.systemKey === "guests" };
      reserved = true;
      break;
    case "audience":
      target = { kind: "audience" };
      break;
    default:
      target = { kind: "person", name: snapshot || (id ? nameOf(id) : undefined) || "" };
  }
  const before = d.before as Shown;
  const after = d.after as Shown;
  const level = (v: Shown): string[] => (typeof v === "string" ? [v] : []);
  const custom = (v: Shown): { allow: string[]; deny: string[] } | undefined =>
    v && typeof v === "object" ? { allow: strings(v.allow), deny: strings(v.deny) } : undefined;
  const slots = { target, resource: { kind: "resource", of: kind, name: str(d.resource_name) || entry.target.label || "" } as Slot };
  const values = { resourceKind: kind };
  const permissions = (v: { allow: string[]; deny: string[] }): AuditLine["diff"] => ({ kind: "permission", added: v.allow, removed: v.deny });
  const customAfter = custom(after);
  if (entry.action === "rule.deleted") {
    const gone = custom(before);
    return line("ruleDeleted", { slots, values, diff: gone ? permissions({ allow: [], deny: [...gone.allow, ...gone.deny] }) : { kind: "level", added: [], removed: level(before) } });
  }
  if (customAfter) return line("ruleCustomised", { slots, values, diff: permissions(customAfter) });
  if (reserved && after === "none" && kind === "channel") return line("ruleReserved", { slots: { ...slots, resource: { ...(slots.resource as Extract<Slot, { kind: "resource" }>), bare: true } }, values, diff: { kind: "level", added: [], removed: level(before) } });
  return line(entry.action === "rule.created" ? "ruleCreated" : "ruleUpdated", { slots, values, diff: { kind: "level", added: level(after), removed: level(before) } });
}

export function auditLine(entry: EntryLike, nameOf: NameOf = () => undefined, refs?: Refs): AuditLine {
  const d = entry.details ?? {};
  const actor: Slot = entry.actor ? { kind: "person", name: entry.actor.name } : { kind: "deleted" };
  // Names are read now by the API; once the thing is gone, the name the log kept is the answer.
  const label = entry.target.label ?? str(d.name);
  const target: Slot = { kind: "person", name: label };
  const line = (sentence: Sentence, extra: Partial<AuditLine> = {}): AuditLine => ({
    sentence,
    slots: { actor, ...extra.slots },
    values: { action: entry.action, ...extra.values },
    diff: extra.diff,
    ...(extra.chips ? { chips: extra.chips } : {}),
    ...(extra.figures ? { figures: extra.figures } : {}),
    ...(extra.report ? { report: extra.report } : {}),
  });
  const group = (name: string): Slot => ({ kind: "group", name, id: entry.target.id });
  const people = (ids: string[]): Slot => ({ kind: "people", names: ids.map((id) => nameOf(id) ?? null) });
  const carried = (roles: string[], removed: boolean, viaGroup: boolean): AuditLine["diff"] =>
    roles.length === 0 ? undefined : { kind: "role", added: removed ? [] : roles, removed: removed ? roles : [], ...(viaGroup ? { viaGroup } : {}) };
  const role = (colour: unknown): Slot => ({ kind: "role", name: label, colour: str(colour) || undefined });

  switch (entry.action) {
    case "import.applied":
      return line("importApplied", {
        slots: { source: { kind: "person", name: sourceLabel(str(d.source)) } },
        figures: chipsFor(d),
        report: reportLink(d.job_id) ?? undefined,
      });
    case "member.joined":
      return line(d.role === "guest" ? "memberJoinedGuest" : "memberJoined");
    case "member.left":
      return line("memberLeft");
    case "member.removed":
      return line("memberRemoved", { slots: { target } });
    case "member.issued_revoked":
      // What the person had issued (invitations and public links) and the server withdrew at their departure.
      return line("memberIssuedRevoked", {
        slots: { target },
        values: { invitations: typeof d.invitations === "number" ? d.invitations : 0, links: typeof d.links === "number" ? d.links : 0 },
      });
    case "member.role_changed":
      return line("memberRoleChanged", {
        slots: { target, before: { kind: "legacy", roles: [str(d.before)] }, after: { kind: "legacy", roles: [str(d.after)] } },
      });
    case "space.ownership_transferred":
      return line("ownershipTransferred", { slots: { target } });
    case "member.roles_changed": {
      const before = named(d.before);
      const after = named(d.after);
      const ids = both(before.map((r) => r.id), after.map((r) => r.id));
      const name = (id: string) => [...before, ...after].find((r) => r.id === id)?.name ?? "";
      return line("memberRolesChanged", {
        slots: { target },
        diff: { kind: "role", added: ids.added.map(name), removed: ids.removed.map(name) },
      });
    }
    case "role.created":
      return line("roleCreated", { slots: { role: role(d.colour) }, diff: { kind: "permission", added: strings(d.permissions), removed: [] } });
    case "role.updated": {
      const before = (d.before ?? {}) as Record<string, unknown>;
      const after = (d.after ?? {}) as Record<string, unknown>;
      const rights = both(strings(before.permissions), strings(after.permissions));
      const renamed = str(before.name) !== str(after.name);
      const diff = { kind: "permission" as const, ...rights };
      if (renamed && rights.added.length === 0 && rights.removed.length === 0) {
        return line("roleRenamed", { slots: { role: role(after.colour) }, values: { before: str(before.name) } });
      }
      return line("roleUpdated", { slots: { role: role(after.colour) }, diff });
    }
    case "role.deleted":
      return line("roleDeleted", { slots: { role: role(d.colour) } });
    case "roles.reordered":
      return line("rolesReordered");
    case "channel.reserved": {
      const after = strings(d.after);
      return line(after.length > 0 ? "channelReserved" : "channelOpened", {
        slots: after.length > 0 ? { roles: { kind: "legacy", roles: after } } : {},
        values: { channel: label },
      });
    }
    case "calendar.write_access_changed":
      return line(d.after === "admins" ? "calendarWriteAdmins" : "calendarWriteMembers", { values: { calendar: label } });
    case "group.created":
      return line("groupCreated", { slots: { group: group(label) } });
    case "group.updated": {
      const before = (d.before ?? {}) as Record<string, unknown>;
      const after = (d.after ?? {}) as Record<string, unknown>;
      if (str(before.name) !== str(after.name)) {
        return line("groupRenamed", { slots: { before: group(str(before.name)), group: group(str(after.name)) } });
      }
      return line("groupDescribed", { slots: { group: group(str(after.name) || label) } });
    }
    case "group.deleted":
      return line(typeof d.members === "number" ? "groupDeleted" : "groupDeletedBare", {
        slots: { group: group(label) },
        values: typeof d.members === "number" ? { count: d.members } : {},
        diff: carried(strings(d.roles), true, true),
      });
    case "group.members_added":
    case "group.members_removed": {
      const ids = strings(d.user_ids);
      const gone = entry.action === "group.members_removed";
      return line(gone ? "groupMembersRemoved" : "groupMembersAdded", {
        slots: { people: people(ids), group: group(label) },
        values: { count: ids.length },
        diff: carried(strings(d.roles), gone, true),
      });
    }
    case "group.roles_changed": {
      const roles = both(strings(d.before), strings(d.after));
      return line("groupRolesChanged", {
        slots: { group: group(label) },
        diff: roles.added.length + roles.removed.length === 0 ? undefined : { kind: "role", ...roles },
      });
    }
    case "group.managers_changed": {
      const managers = both(strings(d.before), strings(d.after));
      const slots = { group: group(label) };
      if (managers.added.length > 0 && managers.removed.length > 0) {
        return line("groupManagersChanged", {
          slots: { ...slots, people: people(managers.added), removedPeople: people(managers.removed) },
          values: { count: managers.added.length },
        });
      }
      const gone = managers.added.length === 0;
      const ids = gone ? managers.removed : managers.added;
      return line(gone ? "groupManagersRemoved" : "groupManagersAdded", { slots: { ...slots, people: people(ids) }, values: { count: ids.length } });
    }
    case "rule.created":
    case "rule.updated":
    case "rule.deleted":
      return ruleLine(entry, nameOf, refs, line);
    case "role.previewed": {
      const named = str(d.role_name) || label;
      return line(d.phase === "ended" ? "rolePreviewEnded" : "rolePreviewStarted", { slots: { role: { kind: "role", name: named, colour: undefined } } });
    }
    case "licence.installed":
      return line("licenceInstalled", { values: { seats: typeof d.seats === "number" ? d.seats : 0, until: str(d.valid_until) } });
    case "licence.removed":
      return line("licenceRemoved");
    case "member.expiry_set": {
      const before = str(d.before);
      const after = str(d.after);
      // A later end is a prolongation, an earlier one brings the end forward; the same day is just a change.
      const later = before && after ? new Date(after).getTime() - new Date(before).getTime() : 0;
      const sentence: Sentence = !before ? "guestExpiryFixed" : !after ? "guestExpiryRemoved" : later > 0 ? "guestExpiryExtended" : later < 0 ? "guestExpiryAdvanced" : "guestExpiryMoved";
      return line(sentence, { slots: { target }, values: { before, after } });
    }
    case "member.expired":
      // The date that was reached; entries from before it was kept fall back on the day the sweep wrote them.
      return line("guestExpired", { slots: { target }, values: { date: str(d.expires_at) || entry.at }, chips: [{ sign: "-", what: "space" }] });
    case "member.reactivated":
      return line("guestReactivated", { slots: { target }, values: { before: str(d.before), after: str(d.after) } });
    case "member.standing_changed": {
      // The date, when the payload carries one (`expires_at: { before, after }`): the end the guest had
      // when they became a member, or the end given as a member became a guest.
      const ends = (d.expires_at ?? {}) as Record<string, unknown>;
      const toGuest = d.after === "guest";
      const date = str(toGuest ? ends.after : ends.before);
      const chips: NonNullable<AuditLine["chips"]> = toGuest
        ? [{ sign: "+", what: "guest" }, { sign: "-", what: "member" }, ...(date ? [{ sign: "+" as const, what: "until" as const, date }] : [])]
        : [{ sign: "+", what: "member" }, { sign: "-", what: "guest" }, ...(date ? [{ sign: "-" as const, what: "until" as const, date }] : [])];
      return line(toGuest ? "memberToGuest" : "guestToMember", { slots: { target }, chips });
    }
    case "member.purged":
      return line("guestPurged", { slots: { target }, chips: [{ sign: "-", what: "space" }] });
    default:
      return line("unknown");
  }
}

/** The day an entry is filed under, in the reader's time: `today`, `yesterday`, else its date. */
export function dayKey(at: string, now: Date = new Date()): string {
  const date = new Date(at);
  const day = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (day(date) === day(now)) return "today";
  if (day(date) === day(yesterday)) return "yesterday";
  return day(date);
}

/**
 * The licence's last month, said before it ends: from 30 days, sharper in the last week (the owners
 * are mailed at 30, 7 and 1 days). Nothing once it has expired (the frozen banner speaks) or
 * without one. The days are counted by `daysLeft`, in the person's display `zone`, like the guest
 * end dates and the instance licence list: one rule everywhere (the server's `expiresInDays` is
 * only the fallback for an end date that cannot be read).
 */
export function daysLeftBanner(
  licence: { validUntil?: string; expiresInDays: number } | undefined,
  edition: "community" | "enterprise" | "frozen",
  now: Date,
  zone: string,
): { tone: "warning" | "danger"; days: number } | null {
  if (!licence || edition !== "enterprise") return null;
  const dated = licence.validUntil && !Number.isNaN(Date.parse(licence.validUntil));
  const days = dated ? daysLeft(licence.validUntil as string, now, zone) : licence.expiresInDays;
  if (days > 30) return null;
  return { tone: days <= 7 ? "danger" : "warning", days };
}
