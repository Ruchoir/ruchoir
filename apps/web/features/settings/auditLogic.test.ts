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
