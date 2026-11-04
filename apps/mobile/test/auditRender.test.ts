import { test } from "node:test";
import assert from "node:assert/strict";

import { auditLine, type Slot } from "@ruchoir/client/permissionsLogic";

import { chipsOf, fillFor, groupEntriesByDay, lineRuns, mergeFirstPage, mergePages, MARK, slotRuns, type Words } from "../src/logic/auditRender.ts";

const words: Words = {
  somebody: "somebody",
  deletedAccount: "deleted account",
  aRole: "a role",
  aGroup: "a group",
  formerMembers: (n) => `${n} former`,
  everyone: (guests) => (guests ? "all guests" : "everyone"),
  readers: "channel readers",
  resourceWord: (of) => ({ channel: "on channel", file: "on file", calendar: "on calendar" })[of],
  resourceUnnamed: (of) => ({ channel: "on a channel", file: "on a file", calendar: "on a calendar" })[of],
  theChannel: "the channel",
  aChannel: "a channel",
  legacy: (role) => `legacy ${role}`,
  roleName: (name) => name,
};

const entry = (id: string, at: string, extra: Record<string, unknown> = {}) => ({
  id,
  at,
  action: "role.created",
  category: "roles",
  actor: { id: "u1", name: "Sophie" },
  target: { kind: "role", label: "Comptable" },
  details: {},
  ...extra,
});

test("a_person_and_a_role_are_bold_the_rest_plain", () => {
  const slots: Record<string, Slot> = { actor: { kind: "person", name: "Sophie" }, role: { kind: "role", name: "Comptable" } };
  const text = `${MARK}actor${MARK} created the role ${MARK}role${MARK}`;
  assert.deepEqual(lineRuns(text, slots, words), [
    { text: "Sophie", bold: true },
    { text: " created the role " },
    { text: "Comptable", bold: true },
  ]);
});

test("the_translation_keeps_its_own_word_order_and_an_unknown_slot_is_dropped", () => {
  const slots: Record<string, Slot> = { actor: { kind: "person", name: "Karim" }, role: { kind: "role", name: "Finances" } };
  assert.deepEqual(lineRuns(`In ${MARK}role${MARK}, by ${MARK}actor${MARK}${MARK}ghost${MARK}`, slots, words), [
    { text: "In " },
    { text: "Finances", bold: true },
    { text: ", by " },
    { text: "Karim", bold: true },
  ]);
});

test("an_unnamed_person_group_or_role_says_so", () => {
  assert.deepEqual(slotRuns({ kind: "person", name: "" }, words), [{ text: "somebody", bold: true }]);
  assert.deepEqual(slotRuns({ kind: "group", name: "" }, words), [{ text: "a group", bold: true }]);
  assert.deepEqual(slotRuns({ kind: "role", name: "" }, words), [{ text: "a role", bold: true }]);
  assert.deepEqual(slotRuns({ kind: "deleted" }, words), [{ text: "deleted account", bold: true }]);
});

test("people_are_bold_names_joined_by_plain_commas_and_former_members_are_counted", () => {
  assert.deepEqual(slotRuns({ kind: "people", names: ["Julie", null, "Hugo", null] }, words), [
    { text: "Julie", bold: true },
    { text: ", " },
    { text: "Hugo", bold: true },
    { text: ", " },
    { text: "2 former", bold: true },
  ]);
});

test("a_resource_keeps_its_preposition_plain_and_its_name_bold_with_a_hash_for_a_channel", () => {
  assert.deepEqual(slotRuns({ kind: "resource", of: "channel", name: "compta" }, words), [{ text: "on channel " }, { text: "#compta", bold: true }]);
  assert.deepEqual(slotRuns({ kind: "resource", of: "file", name: "Budget" }, words), [{ text: "on file " }, { text: "Budget", bold: true }]);
  assert.deepEqual(slotRuns({ kind: "resource", of: "calendar", name: "" }, words), [{ text: "on a calendar" }]);
  assert.deepEqual(slotRuns({ kind: "resource", of: "channel", name: "compta", bare: true }, words), [{ text: "the channel " }, { text: "#compta", bold: true }]);
  assert.deepEqual(slotRuns({ kind: "resource", of: "channel", name: "", bare: true }, words), [{ text: "a channel " }]);
});

test("everyone_readers_and_legacy_roles_are_bold", () => {
  assert.deepEqual(slotRuns({ kind: "everyone", guests: true }, words), [{ text: "all guests", bold: true }]);
  assert.deepEqual(slotRuns({ kind: "audience" }, words), [{ text: "channel readers", bold: true }]);
  assert.deepEqual(slotRuns({ kind: "legacy", roles: ["admin", "guest"] }, words), [{ text: "legacy admin, legacy guest", bold: true }]);
});

test("the_values_of_a_line_fill_the_sentence_with_dates_said_by_the_screen", () => {
  const line = auditLine({ ...entry("1", "2026-11-04T10:00:00Z", { action: "licence.installed", category: "licence", details: { seats: 25, valid_until: "2027-01-14T00:00:00Z" } }), target: { kind: "licence" } });
  const fill = fillFor(line, (iso, kind) => `${kind}:${iso.slice(0, 10)}`);
  assert.equal(fill.count, 25);
  assert.equal(fill.until, "long:2027-01-14");
  assert.equal(fill.actor, `${MARK}actor${MARK}`);
});

test("the_diff_and_the_guest_pastilles_become_signed_lines", () => {
  const line = auditLine(entry("1", "2026-11-04T10:00:00Z", { action: "role.updated", details: { before: { name: "A", permissions: ["files.view"] }, after: { name: "A", permissions: ["files.edit"] } } }));
  const chips = chipsOf(line, { permission: (n) => `perm ${n}`, level: (n) => `level ${n}`, role: (n) => `role ${n}`, viaGroup: (n) => `${n} by group`, standing: (w) => `standing ${w}`, until: (d) => `until ${d}`, space: "space", noEnd: "no end" });
  assert.deepEqual(chips, [
    { sign: "+", text: "perm files.edit" },
    { sign: "-", text: "perm files.view" },
  ]);
});

test("a_moved_guest_end_shows_the_new_date_then_the_old_one", () => {
  const line = auditLine({ ...entry("1", "2026-11-04T10:00:00Z", { action: "member.expiry_set", category: "guests", details: { before: "2026-12-01T00:00:00Z", after: "2027-01-01T00:00:00Z" } }), target: { kind: "member", label: "Thomas" } });
  const w = { permission: String, level: String, role: String, viaGroup: String, standing: String, until: (d: string) => `until ${d.slice(0, 10)}`, space: "space", noEnd: "no end" };
  assert.deepEqual(chipsOf(line, w), [{ sign: "+", text: "until 2027-01-01" }, { sign: "-", text: "until 2026-12-01" }]);
  const cleared = auditLine({ ...entry("2", "2026-11-04T10:00:00Z", { action: "member.expiry_set", category: "guests", details: { before: "2026-12-01T00:00:00Z", after: "" } }), target: { kind: "member", label: "Thomas" } });
  assert.deepEqual(chipsOf(cleared, w), [{ sign: "-", text: "until 2026-12-01" }]);
});

test("pages_merge_without_duplicates_keeping_the_newest_first_order", () => {
  const a = entry("a", "2026-11-04T10:00:00Z");
  const b = entry("b", "2026-11-03T10:00:00Z");
  const c = entry("c", "2026-11-02T10:00:00Z");
  assert.deepEqual(mergePages([a, b], [b, c]).map((e) => e.id), ["a", "b", "c"]);
  assert.deepEqual(mergePages([], [a]).map((e) => e.id), ["a"]);
});

test("entries_group_by_the_reader_s_day_in_the_log_s_order", () => {
  const list = [entry("1", "2026-11-04T10:12:00Z"), entry("2", "2026-11-04T09:03:00Z"), entry("3", "2026-11-03T16:42:00Z")];
  const days = groupEntriesByDay(list, "Europe/Paris");
  assert.deepEqual(days.map((d) => [d.day, d.entries.map((e) => e.id)]), [["2026-11-04", ["1", "2"]], ["2026-11-03", ["3"]]]);
  // 23:30 UTC is already the next day in Paris.
  assert.equal(groupEntriesByDay([entry("4", "2026-11-03T23:30:00Z")], "Europe/Paris")[0]?.day, "2026-11-04");
});

test("a_fresh_first_page_adds_the_new_entries_on_top_and_keeps_the_pages_loaded", () => {
  const a = entry("a", "2026-11-04T10:00:00Z");
  const b = entry("b", "2026-11-03T10:00:00Z");
  const c = entry("c", "2026-11-02T10:00:00Z");
  const fresh = entry("n", "2026-11-04T11:00:00Z");
  // Two pages were loaded (a, b, c); the first page now reads n, a, b: c stays, n comes first.
  assert.deepEqual(mergeFirstPage([a, b, c], [fresh, a, b]).map((e) => e.id), ["n", "a", "b", "c"]);
  // Nothing new: the very same list (no scroll jump, no reorder).
  assert.deepEqual(mergeFirstPage([a, b, c], [a, b]).map((e) => e.id), ["a", "b", "c"]);
  assert.deepEqual(mergeFirstPage([], [a]).map((e) => e.id), ["a"]);
});
