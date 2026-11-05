// Run with `pnpm --filter @ruchoir/client test` (Node's own runner, types stripped by Node).
import { test } from "node:test";
import assert from "node:assert/strict";

import { auditLine, daysLeftBanner, dayKey } from "../src/permissionsLogic/audit.ts";

const entry = (action: string, over: Partial<{ actor: { id: string; name: string } | undefined; target: { kind: string; id?: string; label?: string }; details: Record<string, unknown> }> = {}) => ({
  id: "e",
  at: "2026-11-03T14:32:00Z",
  action,
  category: "x",
  actor: "actor" in over ? over.actor : { id: "6c0d05b2-3229-5271-af34-15698f45781b", name: "Karim" },
  target: over.target ?? { kind: "member", id: "5a0f813b-6575-529f-9c0d-d890fdb2719c", label: "Hugo" },
  details: over.details ?? {},
});

test("each_action_has_its_sentence", () => {
  const sentences = [
    ["member.joined", "memberJoined"],
    ["member.left", "memberLeft"],
    ["member.removed", "memberRemoved"],
    ["member.issued_revoked", "memberIssuedRevoked"],
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
      details: { before: [{ id: "b3440689-d9a5-5d23-9840-946bb99e3de4", name: "Comptable" }], after: [{ id: "b3440689-d9a5-5d23-9840-946bb99e3de4", name: "Comptable" }, { id: "ea31c985-acc4-5004-9b47-5691edcb4907", name: "Communication" }] },
    }),
  );
  assert.deepEqual(line.diff, { kind: "role", added: ["Communication"], removed: [] });
});

test("a_role_edit_counts_its_rights_both_ways_and_a_rename_says_it", () => {
  const before = { name: "Communication", colour: "sun", permissions: ["message.mention_all", "channels.create"] };
  const after = { name: "Communication", colour: "sun", permissions: ["channels.create", "members.invite"] };
  const line = auditLine(entry("role.updated", { target: { kind: "role", id: "c6f204bc-8cc0-55a4-b2e2-799dcda9120e", label: "Communication" }, details: { name: "Communication", before, after } }));
  assert.equal(line.sentence, "roleUpdated");
  assert.deepEqual(line.diff, { kind: "permission", added: ["members.invite"], removed: ["message.mention_all"] });
  assert.deepEqual(line.slots.role, { kind: "role", name: "Communication", colour: "sun" });
  const renamed = auditLine(
    entry("role.updated", { target: { kind: "role", id: "c6f204bc-8cc0-55a4-b2e2-799dcda9120e", label: "Com" }, details: { name: "Com", before, after: { ...before, name: "Com" } } }),
  );
  assert.equal(renamed.sentence, "roleRenamed");
  assert.equal(renamed.values.before, "Communication");
});

test("a_role_gone_is_named_from_the_log", () => {
  // The read API names nothing once the role is deleted: the name kept in the details does.
  const line = auditLine(entry("role.deleted", { target: { kind: "role", id: "c6f204bc-8cc0-55a4-b2e2-799dcda9120e" }, details: { name: "Stagiaires", permissions: [] } }));
  assert.deepEqual(line.slots.role, { kind: "role", name: "Stagiaires", colour: undefined });
  const created = auditLine(entry("role.created", { target: { kind: "role", id: "c6f204bc-8cc0-55a4-b2e2-799dcda9120e", label: "Com" }, details: { name: "Com", colour: "sun", permissions: ["channels.create"] } }));
  assert.deepEqual(created.diff, { kind: "permission", added: ["channels.create"], removed: [] });
});

test("a_channel_reserved_names_who_it_is_for", () => {
  const line = auditLine(entry("channel.reserved", { target: { kind: "channel", id: "42b3314a-a7ba-5dc0-95b9-d25d35196de3", label: "direction" }, details: { name: "direction", before: [], after: ["admin"] } }));
  assert.equal(line.sentence, "channelReserved");
  assert.deepEqual(line.slots.roles, { kind: "legacy", roles: ["admin"] });
  assert.equal(line.values.channel, "direction");
});

test("a_calendar_says_who_writes_in_it_now", () => {
  const line = auditLine(entry("calendar.write_access_changed", { target: { kind: "calendar", id: "42b3314a-a7ba-5dc0-95b9-d25d35196de3", label: "Chantiers" }, details: { name: "Chantiers", before: "members", after: "admins" } }));
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
  const now = new Date("2026-11-01T10:00:00Z");
  const ends = (days: number) => ({ validUntil: new Date(now.getTime() + days * 86400000).toISOString(), expiresInDays: days });
  assert.equal(daysLeftBanner(ends(120), "enterprise", now, "UTC"), null);
  assert.deepEqual(daysLeftBanner(ends(30), "enterprise", now, "UTC"), { tone: "warning", days: 30 });
  assert.deepEqual(daysLeftBanner(ends(7), "enterprise", now, "UTC"), { tone: "danger", days: 7 });
  // An end date that cannot be read falls back on the server's count.
  assert.deepEqual(daysLeftBanner({ validUntil: "", expiresInDays: 5 }, "enterprise", now, "UTC"), { tone: "danger", days: 5 });
  // Expired, the frozen banner says it; without a licence there is nothing to count.
  assert.equal(daysLeftBanner({ expiresInDays: 0 }, "frozen", now, "UTC"), null);
  assert.equal(daysLeftBanner(undefined, "community", now, "UTC"), null);
});

const group = { kind: "group", id: "7532ecb1-2661-5a23-b725-0713adf42f31", label: "Comptabilité" };
const names: Record<string, string> = { u1: "Nadia Haddad", u2: "Paul Girard" };
const nameOf = (id: string) => names[id];

test("every_group_action_has_a_sentence", () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ["group.created", { name: "Comptabilité", description: "" }, "groupCreated"],
    ["group.updated", { before: { name: "Rennes", description: "" }, after: { name: "Chantier Rennes", description: "" } }, "groupRenamed"],
    ["group.updated", { before: { name: "Rennes", description: "b3440689-d9a5-5d23-9840-946bb99e3de4" }, after: { name: "Rennes", description: "ea31c985-acc4-5004-9b47-5691edcb4907" } }, "groupDescribed"],
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
  assert.deepEqual(added.slots.group, { kind: "group", name: "Comptabilité", id: "7532ecb1-2661-5a23-b725-0713adf42f31" });
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

test("a_group_deleted_without_a_head_count_omits_it", () => {
  const line = auditLine(entry("group.deleted", { target: group, details: { name: "Comptabilité", roles: [] } }));
  assert.equal(line.sentence, "groupDeletedBare");
  assert.equal("count" in line.values, false);
});

test("a_person_who_left_is_not_called_a_deleted_account", () => {
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
  const renamed = auditLine(entry("group.updated", { target: { kind: "group", id: "7532ecb1-2661-5a23-b725-0713adf42f31", label: "Chantier Rennes" }, details: { before: { name: "Rennes", description: "" }, after: { name: "Chantier Rennes", description: "x" } } }));
  assert.equal(renamed.sentence, "groupRenamed");
  assert.deepEqual(renamed.slots.before, { kind: "group", name: "Rennes", id: "7532ecb1-2661-5a23-b725-0713adf42f31" });
  assert.deepEqual(renamed.slots.group, { kind: "group", name: "Chantier Rennes", id: "7532ecb1-2661-5a23-b725-0713adf42f31" });
  const created = auditLine(entry("group.created", { target: { kind: "group", id: "7532ecb1-2661-5a23-b725-0713adf42f31" }, details: { name: "Comptabilité" } }));
  assert.deepEqual(created.slots.group, { kind: "group", name: "Comptabilité", id: "7532ecb1-2661-5a23-b725-0713adf42f31" });
});

const rule = (action: string, details: Record<string, unknown>, target = { kind: "channel", id: "b49f8860-af63-541d-a527-157ee6adbcd3", label: "compta" }) => entry(action, { target, details });
const refs = {
  group: (id: string) => (id === "7532ecb1-2661-5a23-b725-0713adf42f31" ? "Comptabilité" : undefined),
  role: (id: string) => (id === "2016d462-2e0e-5ede-948c-8cf9acd31845" ? { name: "Members", systemKey: "members" } : id === "65396209-6e7e-52e9-b1a0-e513e361c852" ? { name: "Guests", systemKey: "guests" } : id === "3633b614-fdd6-5fc5-a819-a8c9d5c56fcd" ? { name: "Comptable" } : undefined),
};

test("every_rule_action_has_a_sentence", () => {
  // Created: the target, the resource, and the level as a single chip.
  const created = auditLine(rule("rule.created", { target_kind: "group", target_id: "7532ecb1-2661-5a23-b725-0713adf42f31", before: null, after: "contribute" }), () => undefined, refs);
  assert.equal(created.sentence, "ruleCreated");
  assert.deepEqual(created.slots.target, { kind: "group", name: "Comptabilité", id: "7532ecb1-2661-5a23-b725-0713adf42f31" });
  assert.deepEqual(created.slots.resource, { kind: "resource", of: "channel", name: "compta" });
  assert.deepEqual(created.diff, { kind: "level", added: ["contribute"], removed: [] });
  assert.equal(created.values.resourceKind, "channel");
  // Updated between two levels: the level before and after as two chips.
  const changed = auditLine(rule("rule.updated", { target_kind: "user", target_id: "932c09bb-7f39-5807-8a3a-fbe253685392", before: "read", after: "contribute" }, { kind: "calendar", id: "6c0d05b2-3229-5271-af34-15698f45781b", label: "Chantiers" }), (id) => (id === "932c09bb-7f39-5807-8a3a-fbe253685392" ? "Nadia" : undefined), refs);
  assert.equal(changed.sentence, "ruleUpdated");
  assert.deepEqual(changed.slots.target, { kind: "person", name: "Nadia" });
  assert.deepEqual(changed.diff, { kind: "level", added: ["contribute"], removed: ["read"] });
  assert.equal(changed.values.resourceKind, "calendar");
  // Updated to a rule that matches no preset: the permissions added and denied.
  const custom = auditLine(rule("rule.updated", { target_kind: "group", target_id: "7532ecb1-2661-5a23-b725-0713adf42f31", before: "contribute", after: { allow: ["message.pin"], deny: ["message.mention_all"] } }), () => undefined, refs);
  assert.equal(custom.sentence, "ruleCustomised");
  assert.deepEqual(custom.diff, { kind: "permission", added: ["message.pin"], removed: ["message.mention_all"] });
  // Deleted: the level that went.
  const deleted = auditLine(rule("rule.deleted", { target_kind: "role", target_id: "3633b614-fdd6-5fc5-a819-a8c9d5c56fcd", before: "read", after: null }), () => undefined, refs);
  assert.equal(deleted.sentence, "ruleDeleted");
  assert.deepEqual(deleted.slots.target, { kind: "role", name: "Comptable" });
  assert.deepEqual(deleted.diff, { kind: "level", added: [], removed: ["read"] });
  // Everyone down to none on a channel is a reservation.
  const reserved = auditLine(rule("rule.updated", { target_kind: "everyone", target_id: "2016d462-2e0e-5ede-948c-8cf9acd31845", before: "contribute", after: "none" }), () => undefined, refs);
  assert.equal(reserved.sentence, "ruleReserved");
  assert.deepEqual(reserved.diff, { kind: "level", added: [], removed: ["contribute"] });
  // The sentence names the channel itself ("a reserve le canal #x"): the slot carries no preposition.
  assert.deepEqual(reserved.slots.resource, { kind: "resource", of: "channel", name: "compta", bare: true });
  // Everyone reads as the members, or the guests.
  const guests = auditLine(rule("rule.created", { target_kind: "everyone", target_id: "65396209-6e7e-52e9-b1a0-e513e361c852", before: null, after: "read" }), () => undefined, refs);
  assert.deepEqual(guests.slots.target, { kind: "everyone", guests: true });
  // A line the log keeps without a name is still a sentence.
  assert.equal(auditLine(rule("rule.created", {}), () => undefined, refs).sentence, "ruleCreated");
});

test("preview_lines_say_started_and_ended", () => {
  const at = (phase: string, over: Record<string, unknown> = {}) =>
    auditLine(entry("role.previewed", { target: { kind: "role", id: "3633b614-fdd6-5fc5-a819-a8c9d5c56fcd", label: "Comptable (label)" }, details: { role_id: "3633b614-fdd6-5fc5-a819-a8c9d5c56fcd", role_name: "Comptable", phase, ...over } }));
  const started = at("started");
  assert.equal(started.sentence, "rolePreviewStarted");
  assert.deepEqual(started.slots.role, { kind: "role", name: "Comptable", colour: undefined });
  const ended = at("ended");
  assert.equal(ended.sentence, "rolePreviewEnded");
  // A line from before the phase existed was a start; the role's name falls back to the target's label.
  assert.equal(auditLine(entry("role.previewed", { target: { kind: "role", id: "3633b614-fdd6-5fc5-a819-a8c9d5c56fcd", label: "Comptable" } })).sentence, "rolePreviewStarted");
  assert.equal(auditLine(entry("role.previewed", { target: { kind: "role", id: "3633b614-fdd6-5fc5-a819-a8c9d5c56fcd", label: "Comptable" } })).slots.role.kind, "role");
});

test("rule_lines_use_the_snapshot_names", () => {
  // The snapshot wins over today's lists: a renamed group still reads as it did that day.
  const named = auditLine(rule("rule.created", { target_kind: "group", target_id: "7532ecb1-2661-5a23-b725-0713adf42f31", target_name: "Ancien nom", resource_name: "ancien-canal", before: null, after: "read" }), () => undefined, refs);
  assert.deepEqual(named.slots.target, { kind: "group", name: "Ancien nom", id: "7532ecb1-2661-5a23-b725-0713adf42f31" });
  assert.deepEqual(named.slots.resource, { kind: "resource", of: "channel", name: "ancien-canal" });
  const person = auditLine(rule("rule.updated", { target_kind: "user", target_id: "932c09bb-7f39-5807-8a3a-fbe253685392", target_name: "Nadia (alors)", resource_name: null, before: "read", after: "manage" }), () => "Nadia (maintenant)", refs);
  assert.deepEqual(person.slots.target, { kind: "person", name: "Nadia (alors)" });
  // A null snapshot falls back to the current lists, then to nothing (the screen says "une personne").
  assert.deepEqual(person.slots.resource, { kind: "resource", of: "channel", name: "compta" });
  const fallback = auditLine(rule("rule.deleted", { target_kind: "user", target_id: "932c09bb-7f39-5807-8a3a-fbe253685392", target_name: null, resource_name: null, before: "read", after: null }, { kind: "channel", id: "42b3314a-a7ba-5dc0-95b9-d25d35196de3" }), (id) => (id === "932c09bb-7f39-5807-8a3a-fbe253685392" ? "Nadia" : undefined), refs);
  assert.deepEqual(fallback.slots.target, { kind: "person", name: "Nadia" });
  assert.deepEqual(fallback.slots.resource, { kind: "resource", of: "channel", name: "" });
  const unknown = auditLine(rule("rule.deleted", { target_kind: "user", target_id: "5ab0b698-ddf7-5f20-b423-425eb08a14dd", target_name: null, resource_name: null, before: "read", after: null }, { kind: "file", id: "9a49e33a-5efb-506c-97f9-a07f0242714f" }), () => undefined, refs);
  assert.deepEqual(unknown.slots.target, { kind: "person", name: "" });
  const role = auditLine(rule("rule.created", { target_kind: "role", target_id: "fa958c3d-31e0-55f7-b8c5-0f0107e2a8a0", target_name: "Ancien rôle", resource_name: "x", before: null, after: "read" }), () => undefined, refs);
  assert.deepEqual(role.slots.target, { kind: "role", name: "Ancien rôle" });
  // Everyone is a base role whatever its stored name.
  assert.deepEqual(auditLine(rule("rule.created", { target_kind: "everyone", target_id: "65396209-6e7e-52e9-b1a0-e513e361c852", target_name: "Guests", resource_name: "x", before: null, after: "read" }), () => undefined, refs).slots.target, { kind: "everyone", guests: true });
});

test("the_invitations_and_links_withdrawn_with_a_departure_are_counted", () => {
  const line = auditLine(entry("member.issued_revoked", { details: { invitations: 2, links: 1 } }));
  assert.equal(line.sentence, "memberIssuedRevoked");
  assert.deepEqual(line.slots.target, { kind: "person", name: "Hugo" });
  assert.equal(line.values.invitations, 2);
  assert.equal(line.values.links, 1);
  // A line from an older server carries no figures: zero, not a hole in the sentence.
  const bare = auditLine(entry("member.issued_revoked")).values;
  assert.equal(bare.invitations, 0);
  assert.equal(bare.links, 0);
});
