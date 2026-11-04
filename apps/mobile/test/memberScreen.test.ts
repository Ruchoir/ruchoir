import { test } from "node:test";
import assert from "node:assert/strict";

import { memberAccessFor, roleIdsToSave, type RoleChoice } from "@ruchoir/client/permissionsLogic";

import {
  changeCount,
  draftOf,
  endedRowText,
  filterCounts,
  filterPeople,
  heldRoles,
  liveDraft,
  memberStatus,
  offersHandOver,
  pickedDay,
  pickedFromEvent,
  systemRoleKey,
  rowAccess,
  shortDay,
  toggleRows,
} from "../src/logic/memberScreen.ts";

const role = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, permissions: [], manageable: true, holders: 0, position: 0, ...extra });
const ROLES = [role("admin", { systemKey: "administrator", manageable: false }), role("acc"), role("com"), role("rh"), role("base", { systemKey: "members" })];

test("the_save_bar_counts_every_role_added_or_removed", () => {
  assert.equal(changeCount(["acc", "com"], ["acc", "com"]), 0);
  assert.equal(changeCount(["acc", "com"], ["acc", "com", "rh"]), 1);
  assert.equal(changeCount(["acc", "com"], ["acc"]), 1);
  assert.equal(changeCount(["acc"], ["com", "rh"]), 3);
  assert.equal(changeCount([], []), 0);
});

test("the_draft_starts_from_the_roles_held_directly", () => {
  const access = memberAccessFor({
    member: { userId: "u", roleIds: ["acc"], manageable: true },
    me: "me",
    edition: "enterprise",
    roles: ROLES,
    viaGroups: new Map([["com", ["Comptabilité"]]]),
  });
  assert.equal(access.mode, "roles");
  if (access.mode !== "roles") return;
  assert.deepEqual([...draftOf(access.choices)], ["acc"]);
});

function choices(held: string[], via: Record<string, string[]> = {}, roles = ROLES): RoleChoice[] {
  const access = memberAccessFor({
    member: { userId: "u", roleIds: held, manageable: true },
    me: "me",
    edition: "enterprise",
    roles,
    viaGroups: new Map(Object.entries(via)),
  });
  assert.equal(access.mode, "roles");
  return access.mode === "roles" ? access.choices : [];
}

test("a_role_above_the_caller_is_disabled_with_its_reason", () => {
  const rows = toggleRows(choices(["acc"]), new Set(["acc"]), { myTopRoleId: "rh" });
  const admin = rows.find((r) => r.roleId === "admin")!;
  assert.equal(admin.disabled, true);
  assert.deepEqual(admin.reason, { key: "roles.aboveYou" });
  assert.equal(rows.find((r) => r.roleId === "acc")!.disabled, false);
});

test("the_callers_own_top_role_says_so", () => {
  const rows = toggleRows(choices([], {}, [role("rh", { manageable: false }), role("acc")]), new Set(), { myTopRoleId: "rh" });
  assert.deepEqual(rows.find((r) => r.roleId === "rh")!.reason, { key: "roles.yourTopRole" });
});

test("a_role_only_a_group_gives_is_on_disabled_and_names_the_group", () => {
  const rows = toggleRows(choices(["acc"], { com: ["Communication"] }), new Set(["acc"]), {});
  const com = rows.find((r) => r.roleId === "com")!;
  assert.equal(com.on, true);
  assert.equal(com.disabled, true);
  assert.equal(com.groupOnly, true);
  assert.deepEqual(com.reason, { key: "groups.viaReason", via: ["Communication"] });
  assert.equal(com.changed, false);
});

test("a_role_given_directly_and_by_a_group_says_both", () => {
  const rows = toggleRows(choices(["acc"], { acc: ["Comptabilité"] }), new Set(["acc"]), {});
  const acc = rows.find((r) => r.roleId === "acc")!;
  assert.equal(acc.disabled, false);
  assert.deepEqual(acc.reason, { key: "groups.alsoDirect", via: ["Comptabilité"] });
});

test("a_toggle_differing_from_the_start_is_marked_changed_and_saving_never_sends_a_group_only_role", () => {
  const list = choices(["acc"], { com: ["Communication"] });
  const draft = new Set(["rh", "com"]);
  const rows = toggleRows(list, draft, {});
  assert.deepEqual(rows.filter((r) => r.changed).map((r) => r.roleId).sort(), ["acc", "rh"]);
  assert.deepEqual(roleIdsToSave(ROLES, list, draft), ["rh"]);
  assert.equal(changeCount(draftOf(list), new Set(roleIdsToSave(ROLES, list, draft))), 2);
});

test("held_roles_come_in_the_spaces_order_with_the_groups_that_give_them", () => {
  const groups = [{ id: "g", name: "Compta", source: "manual" as const, memberIds: ["u"], managerIds: [], roleIds: ["com", "acc"] }];
  const held = heldRoles({ userId: "u", roleIds: ["acc", "rh"] }, ROLES, groups);
  assert.deepEqual(held.map((h) => [h.role.id, h.via]), [["acc", []], ["com", ["Compta"]], ["rh", []]]);
});

test("filter_counts_split_the_people_into_members_and_guests", () => {
  const people = [
    { role: "owner", bot: false },
    { role: "member", bot: false },
    { role: "member", bot: false },
    { role: "guest", bot: false },
    { role: "guest", bot: false },
    { role: "member", bot: true },
  ];
  assert.deepEqual(filterCounts(people), { all: 6, members: 3, guests: 2 });
  assert.equal(filterPeople(people, "guests").length, 2);
  assert.equal(filterPeople(people, "members").length, 3);
  assert.equal(filterPeople(people, "all").length, 6);
  // Each chip's count is the length of the list it opens; a bot is listed under Tous only.
  for (const f of ["all", "members", "guests"] as const) assert.equal(filterCounts(people)[f], filterPeople(people, f).length);
});

test("a_row_shows_a_lock_for_oneself_and_for_those_above_and_a_chevron_otherwise", () => {
  const me = "me";
  assert.equal(rowAccess({ userId: "me", bot: false, manageable: true }, me, true), "locked");
  assert.equal(rowAccess({ userId: "x", bot: false, manageable: false }, me, true), "locked");
  assert.equal(rowAccess({ userId: "x", bot: false, manageable: true }, me, true), "open");
  assert.equal(rowAccess({ userId: "x", bot: true, manageable: true }, me, true), "none");
});

test("a_view_only_viewer_sees_no_lock_no_label_and_no_chevron_on_any_row", () => {
  const me = "me";
  assert.equal(rowAccess({ userId: "x", bot: false, manageable: false }, me, false), "none");
  assert.equal(rowAccess({ userId: "x", bot: false, manageable: true }, me, false), "none");
  assert.equal(rowAccess({ userId: "me", bot: false, manageable: false }, me, false), "none");
});

test("a_date_picker_that_was_dismissed_picks_nothing", () => {
  const date = new Date(2026, 10, 7, 12);
  assert.equal(pickedFromEvent({ type: "set" }, date), "2026-11-07");
  assert.equal(pickedFromEvent({ type: "dismissed" }, date), null);
  assert.equal(pickedFromEvent({ type: "neutralButtonPressed" }, date), null);
  assert.equal(pickedFromEvent({ type: "set" }, undefined), null);
});

test("the_owner_can_hand_the_space_to_anyone_but_a_bot_or_the_owner", () => {
  assert.equal(offersHandOver("owner", { role: "member" }), true);
  assert.equal(offersHandOver("owner", { role: "admin" }), true);
  assert.equal(offersHandOver("owner", { role: "guest" }), true);
  assert.equal(offersHandOver("owner", { role: "owner" }), false);
  assert.equal(offersHandOver("owner", { role: "member", bot: true }), false);
  assert.equal(offersHandOver("admin", { role: "member" }), false);
});

test("a_draft_lives_until_the_saved_roles_change_under_it", () => {
  const set = new Set(["a", "b"]);
  const edit = { base: "a", set };
  assert.equal(liveDraft(edit, "a"), set);
  assert.equal(liveDraft(edit, "a,b"), null);
  assert.equal(liveDraft(null, "a"), null);
});

test("a_member_screen_waits_for_the_space_it_was_opened_in_before_judging_the_person", () => {
  assert.equal(memberStatus({ spaceId: "s2", currentId: "s1", listed: true, found: false }), "loading");
  assert.equal(memberStatus({ spaceId: "s2", currentId: "s2", listed: false, found: false }), "loading");
  assert.equal(memberStatus({ spaceId: "s2", currentId: "s2", listed: true, found: false }), "gone");
  assert.equal(memberStatus({ spaceId: "s2", currentId: "s2", listed: true, found: true }), "ready");
  assert.equal(memberStatus({ currentId: "s1", listed: true, found: false }), "gone");
});

test("a_guest_end_is_a_short_day_in_the_phones_zone_and_carries_the_year_only_when_it_is_not_this_one", () => {
  const now = new Date("2026-11-04T10:00:00Z");
  assert.equal(shortDay("2026-11-07T22:59:59Z", "fr", "Europe/Paris", now), "7 nov.");
  assert.equal(shortDay("2026-11-07T22:59:59Z", "fr", "Pacific/Auckland", now), "8 nov.");
  assert.match(shortDay("2027-02-03T10:00:00Z", "fr", "Europe/Paris", now), /2027/);
});

test("an_ended_access_row_says_when_it_ended_and_how_long_ago", () => {
  const now = new Date("2026-11-04T10:00:00Z");
  const text = endedRowText({ userId: "u", name: "Inès Rousseau", endedAt: "2026-10-28T10:00:00Z", daysLeftToKeep: 83 }, now, "fr", "Europe/Paris");
  assert.deepEqual(text, { name: "Inès Rousseau", title: undefined, endedOn: "28 oct.", ago: "Il y a 7 jours" });
});

test("a_picked_day_is_written_from_the_phones_own_calendar_day", () => {
  assert.equal(pickedDay(new Date(2026, 10, 7, 23, 30)), "2026-11-07");
  assert.equal(pickedDay(new Date(2027, 0, 3, 0, 5)), "2027-01-03");
});

test("system_roles_are_named_by_the_dictionary_and_the_others_by_hand", () => {
  assert.equal(systemRoleKey({ systemKey: "administrator" }), "role.admin");
  assert.equal(systemRoleKey({ systemKey: "members" }), "roles.everyone");
  assert.equal(systemRoleKey({ systemKey: "guests" }), "roles.guests");
  assert.equal(systemRoleKey({}), null);
});
