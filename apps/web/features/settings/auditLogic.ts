/**
 * What the Journal tab says about each line of a space's audit log, apart from drawing it: which
 * sentence, who and what fill it, and the rights or roles added and taken away. The screen maps
 * each sentence to its dictionary key; nothing here reads a translation.
 */

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
  | { kind: "legacy"; roles: string[] };

export type Sentence =
  | "memberJoined"
  | "memberJoinedGuest"
  | "memberLeft"
  | "memberRemoved"
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
  | "licenceInstalled"
  | "licenceRemoved"
  | "unknown";

export type AuditLine = {
  sentence: Sentence;
  /** Who and what, drawn as a name or a pastille. Always `actor`. */
  slots: Record<string, Slot>;
  /** Plain values: a channel's or calendar's name, seats, a date (ISO 8601), the action. */
  values: Record<string, string | number>;
  /** `viaGroup`: the roles come with a group, so each chip says "by the group". */
  diff?: { kind: "permission" | "role"; added: string[]; removed: string[]; viaGroup?: boolean };
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

export function auditLine(entry: EntryLike, nameOf: NameOf = () => undefined): AuditLine {
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
  });
  const group = (name: string): Slot => ({ kind: "group", name, id: entry.target.id });
  const people = (ids: string[]): Slot => ({ kind: "people", names: ids.map((id) => nameOf(id) ?? null) });
  const carried = (roles: string[], removed: boolean, viaGroup: boolean): AuditLine["diff"] =>
    roles.length === 0 ? undefined : { kind: "role", added: removed ? [] : roles, removed: removed ? roles : [], ...(viaGroup ? { viaGroup } : {}) };
  const role = (colour: unknown): Slot => ({ kind: "role", name: label, colour: str(colour) || undefined });

  switch (entry.action) {
    case "member.joined":
      return line(d.role === "guest" ? "memberJoinedGuest" : "memberJoined");
    case "member.left":
      return line("memberLeft");
    case "member.removed":
      return line("memberRemoved", { slots: { target } });
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
    case "licence.installed":
      return line("licenceInstalled", { values: { seats: typeof d.seats === "number" ? d.seats : 0, until: str(d.valid_until) } });
    case "licence.removed":
      return line("licenceRemoved");
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
 * without one.
 */
export function daysLeftBanner(
  licence: { expiresInDays: number } | undefined,
  edition: "community" | "enterprise" | "frozen",
): { tone: "warning" | "danger"; days: number } | null {
  if (!licence || edition !== "enterprise") return null;
  if (licence.expiresInDays > 30) return null;
  return { tone: licence.expiresInDays <= 7 ? "danger" : "warning", days: licence.expiresInDays };
}
