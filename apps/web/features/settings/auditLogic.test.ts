import { test } from "node:test";
import assert from "node:assert/strict";

import { auditLine, daysLeftBanner, dayKey } from "./auditLogic.ts";

const entry = (action: string, over: Partial<{ actor: { id: string; name: string } | undefined; target: { kind: string; id?: string; label?: string }; details: Record<string, unknown> }> = {}) => ({
  id: "e",
  at: "2026-11-03T14:32:00Z",
  action,
  category: "x",
  actor: "actor" in over ? over.actor : { id: "k", name: "Karim" },
  target: over.target ?? { kind: "member", id: "h", label: "Hugo" },
  details: over.details ?? {},
});

test("each_action_has_its_sentence", () => {
  const sentences = [
    ["member.joined", "memberJoined"],
    ["member.left", "memberLeft"],
    ["member.removed", "memberRemoved"],
    ["member.role_changed", "memberRoleChanged"],
    ["space.ownership_transferred", "ownershipTransferred"],
    ["member.roles_changed", "memberRolesChanged"],
    ["role.created", "roleCreated"],
    ["role.updated", "roleUpdated"],
    ["role.deleted", "roleDeleted"],
    ["roles.reordered", "rolesReordered"],
    ["channel.reserved", "channelOpened"],
    ["calendar.write_access_changed", "calendarWriteMembers"],
    ["licence.installed", "licenceInstalled"],
    ["licence.removed", "licenceRemoved"],
    ["something.new", "unknown"],
  ];
  for (const [action, sentence] of sentences) {
    assert.equal(auditLine(entry(action)).sentence, sentence, action);
  }
});

test("a_deleted_account_is_said_so", () => {
  const line = auditLine(entry("member.removed", { actor: undefined }));
  assert.deepEqual(line.slots.actor, { kind: "deleted" });
  assert.deepEqual(line.slots.target, { kind: "person", name: "Hugo" });
});

test("a_guest_joining_says_it", () => {
  assert.equal(auditLine(entry("member.joined", { details: { role: "guest" } })).sentence, "memberJoinedGuest");
});

test("a_role_change_names_the_roles_added_and_taken_away", () => {
  const line = auditLine(
    entry("member.roles_changed", {
      details: { before: [{ id: "a", name: "Comptable" }], after: [{ id: "a", name: "Comptable" }, { id: "b", name: "Communication" }] },
    }),
  );
  assert.deepEqual(line.diff, { kind: "role", added: ["Communication"], removed: [] });
});

test("a_role_edit_counts_its_rights_both_ways_and_a_rename_says_it", () => {
  const before = { name: "Communication", colour: "sun", permissions: ["message.mention_all", "channels.create"] };
  const after = { name: "Communication", colour: "sun", permissions: ["channels.create", "members.invite"] };
  const line = auditLine(entry("role.updated", { target: { kind: "role", id: "r", label: "Communication" }, details: { name: "Communication", before, after } }));
  assert.equal(line.sentence, "roleUpdated");
  assert.deepEqual(line.diff, { kind: "permission", added: ["members.invite"], removed: ["message.mention_all"] });
  assert.deepEqual(line.slots.role, { kind: "role", name: "Communication", colour: "sun" });
  const renamed = auditLine(
    entry("role.updated", { target: { kind: "role", id: "r", label: "Com" }, details: { name: "Com", before, after: { ...before, name: "Com" } } }),
  );
  assert.equal(renamed.sentence, "roleRenamed");
  assert.equal(renamed.values.before, "Communication");
});

test("a_role_gone_is_named_from_the_log", () => {
  // The read API names nothing once the role is deleted: the name kept in the details does.
  const line = auditLine(entry("role.deleted", { target: { kind: "role", id: "r" }, details: { name: "Stagiaires", permissions: [] } }));
  assert.deepEqual(line.slots.role, { kind: "role", name: "Stagiaires", colour: undefined });
  const created = auditLine(entry("role.created", { target: { kind: "role", id: "r", label: "Com" }, details: { name: "Com", colour: "sun", permissions: ["channels.create"] } }));
  assert.deepEqual(created.diff, { kind: "permission", added: ["channels.create"], removed: [] });
});

test("a_channel_reserved_names_who_it_is_for", () => {
  const line = auditLine(entry("channel.reserved", { target: { kind: "channel", id: "c", label: "direction" }, details: { name: "direction", before: [], after: ["admin"] } }));
  assert.equal(line.sentence, "channelReserved");
  assert.deepEqual(line.slots.roles, { kind: "legacy", roles: ["admin"] });
  assert.equal(line.values.channel, "direction");
});

test("a_calendar_says_who_writes_in_it_now", () => {
  const line = auditLine(entry("calendar.write_access_changed", { target: { kind: "calendar", id: "c", label: "Chantiers" }, details: { name: "Chantiers", before: "members", after: "admins" } }));
  assert.equal(line.sentence, "calendarWriteAdmins");
  assert.equal(line.values.calendar, "Chantiers");
});

test("a_licence_says_its_seats_and_its_end", () => {
  const line = auditLine(entry("licence.installed", { target: { kind: "licence" }, details: { seats: 25, valid_until: "2027-12-31T23:59:59Z", organisation: "Atelier" } }));
  assert.equal(line.values.seats, 25);
  assert.equal(line.values.until, "2027-12-31T23:59:59Z");
});

test("entries_are_grouped_by_local_day", () => {
  const now = new Date(2026, 10, 3, 18, 0);
  assert.equal(dayKey(new Date(2026, 10, 3, 9, 0).toISOString(), now), "today");
  assert.equal(dayKey(new Date(2026, 10, 2, 23, 0).toISOString(), now), "yesterday");
  assert.equal(dayKey(new Date(2026, 9, 30, 12, 0).toISOString(), now), "2026-10-30");
});

test("the_licence_warns_in_its_last_month", () => {
  assert.equal(daysLeftBanner({ expiresInDays: 120 }, "enterprise"), null);
  assert.deepEqual(daysLeftBanner({ expiresInDays: 30 }, "enterprise"), { tone: "warning", days: 30 });
  assert.deepEqual(daysLeftBanner({ expiresInDays: 7 }, "enterprise"), { tone: "danger", days: 7 });
  // Expired, the frozen banner says it; without a licence there is nothing to count.
  assert.equal(daysLeftBanner({ expiresInDays: 0 }, "frozen"), null);
  assert.equal(daysLeftBanner(undefined, "community"), null);
});

const group = { kind: "group", id: "g1", label: "Comptabilité" };
const names: Record<string, string> = { u1: "Nadia Haddad", u2: "Paul Girard" };
const nameOf = (id: string) => names[id];

test("every_group_action_has_a_sentence", () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ["group.created", { name: "Comptabilité", description: "" }, "groupCreated"],
    ["group.updated", { before: { name: "Rennes", description: "" }, after: { name: "Chantier Rennes", description: "" } }, "groupRenamed"],
    ["group.updated", { before: { name: "Rennes", description: "a" }, after: { name: "Rennes", description: "b" } }, "groupDescribed"],
    ["group.deleted", { name: "Stagiaires 2025", members: 2, roles: ["Communication"] }, "groupDeleted"],
    ["group.members_added", { user_ids: ["u1"], roles: ["Comptable"] }, "groupMembersAdded"],
    ["group.members_removed", { user_ids: ["u2"], roles: ["Comptable"] }, "groupMembersRemoved"],
    ["group.roles_changed", { before: [], after: ["Comptable"] }, "groupRolesChanged"],
    ["group.managers_changed", { before: [], after: ["u1"] }, "groupManagersAdded"],
    ["group.managers_changed", { before: ["u1"], after: [] }, "groupManagersRemoved"],
  ];
  for (const [action, details, sentence] of cases) {
    assert.equal(auditLine(entry(action, { target: group, details }), nameOf).sentence, sentence, `${action} ${sentence}`);
  }
});

test("group_roles_received_or_lost_show_as_chips_and_people_are_named", () => {
  const added = auditLine(entry("group.members_added", { target: group, details: { user_ids: ["u1", "u2"], roles: ["Comptable"] } }), nameOf);
  assert.deepEqual(added.slots.people, { kind: "people", names: ["Nadia Haddad", "Paul Girard"] });
  assert.deepEqual(added.slots.group, { kind: "group", name: "Comptabilité", id: "g1" });
  assert.deepEqual(added.diff, { kind: "role", added: ["Comptable"], removed: [], viaGroup: true });
  assert.equal(added.values.count, 2);

  const removed = auditLine(entry("group.members_removed", { target: group, details: { user_ids: ["u2"], roles: ["Comptable"] } }), nameOf);
  assert.deepEqual(removed.diff, { kind: "role", added: [], removed: ["Comptable"], viaGroup: true });

  const roles = auditLine(entry("group.roles_changed", { target: group, details: { before: ["Comptable"], after: ["Communication"] } }), nameOf);
  assert.deepEqual(roles.diff, { kind: "role", added: ["Communication"], removed: ["Comptable"] });

  const deleted = auditLine(entry("group.deleted", { target: group, details: { name: "Comptabilité", members: 3, roles: ["Communication"] } }), nameOf);
  assert.deepEqual(deleted.diff, { kind: "role", added: [], removed: ["Communication"], viaGroup: true });
  assert.equal(deleted.values.count, 3);
});

test("a_group_line_without_carried_roles_has_no_chips", () => {
  const line = auditLine(entry("group.members_added", { target: group, details: { user_ids: ["u1"], roles: [] } }), nameOf);
  assert.equal(line.diff, undefined);
});

test("an_unknown_person_in_a_group_line_is_a_deleted_account", () => {
  const line = auditLine(entry("group.members_added", { target: group, details: { user_ids: ["u1", "gone"], roles: [] } }), nameOf);
  assert.deepEqual(line.slots.people, { kind: "people", names: ["Nadia Haddad", null] });
  const managers = auditLine(entry("group.managers_changed", { target: group, details: { before: ["gone"], after: [] } }));
  assert.deepEqual(managers.slots.people, { kind: "people", names: [null] });
});

test("managers_changed_names_who_was_added_or_removed", () => {
  const both = auditLine(entry("group.managers_changed", { target: group, details: { before: ["u1"], after: ["u2"] } }), nameOf);
  assert.equal(both.sentence, "groupManagersChanged");
  assert.deepEqual(both.slots.people, { kind: "people", names: ["Paul Girard"] });
  assert.deepEqual(both.slots.removedPeople, { kind: "people", names: ["Nadia Haddad"] });
  assert.equal(both.diff, undefined);
});

test("a_group_rename_and_an_empty_description_stay_readable", () => {
  const renamed = auditLine(entry("group.updated", { target: { kind: "group", id: "g1", label: "Chantier Rennes" }, details: { before: { name: "Rennes", description: "" }, after: { name: "Chantier Rennes", description: "x" } } }));
  assert.equal(renamed.sentence, "groupRenamed");
  assert.deepEqual(renamed.slots.before, { kind: "group", name: "Rennes", id: "g1" });
  assert.deepEqual(renamed.slots.group, { kind: "group", name: "Chantier Rennes", id: "g1" });
  const created = auditLine(entry("group.created", { target: { kind: "group", id: "g1" }, details: { name: "Comptabilité" } }));
  assert.deepEqual(created.slots.group, { kind: "group", name: "Comptabilité", id: "g1" });
});
