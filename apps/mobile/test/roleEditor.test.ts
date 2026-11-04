import { test } from "node:test";
import assert from "node:assert/strict";

import { COLOUR_CHOICES, changeCount, editorAccess, editorDraft, familyRows, newRoleColour, roleSignature, rolesWith, saveBlock, savePayload, usedInRowsOf } from "../src/logic/roleEditor.ts";

type R = { id: string; name: string; colour?: string; permissions: string[]; manageable: boolean; systemKey?: "administrator" | "members" | "guests" };
const accountant: R = { id: "acc", name: "Comptable", colour: "mint", permissions: ["channel.view", "message.send", "files.view"], manageable: true };
const draftOf = (role: R) => ({ name: role.name, colour: role.colour ?? "sky", permissions: new Set(role.permissions) });

test("nothing_edited_counts_no_change", () => {
  assert.equal(changeCount(accountant, draftOf(accountant)), 0);
});

test("name_colour_and_permissions_each_count", () => {
  const draft = draftOf(accountant);
  draft.name = "Comptabilité";
  assert.equal(changeCount(accountant, draft), 1);
  draft.colour = "pink";
  assert.equal(changeCount(accountant, draft), 2);
  draft.permissions.add("members.view");
  draft.permissions.delete("files.view");
  assert.equal(changeCount(accountant, draft), 4);
});

test("a_name_that_only_differs_by_spaces_is_not_a_change", () => {
  const draft = draftOf(accountant);
  draft.name = "  Comptable ";
  assert.equal(changeCount(accountant, draft), 0);
});

test("the_save_sends_only_what_changed", () => {
  const draft = draftOf(accountant);
  draft.colour = "pink";
  assert.deepEqual(savePayload(accountant, draft), { colour: "pink" });
  draft.permissions.add("members.view");
  assert.deepEqual(savePayload(accountant, draft), { colour: "pink", permissions: ["members.view", "channel.view", "message.send", "files.view"] });
});

test("an_empty_name_cannot_be_saved", () => {
  const draft = draftOf(accountant);
  draft.name = "   ";
  assert.equal(savePayload(accountant, draft), null);
});

test("a_right_the_caller_lacks_is_locked_with_its_reason", () => {
  const families = familyRows(accountant, draftOf(accountant), { viewerRights: ["message.send", "channel.view", "files.view"], membersBase: [] });
  const rows = families.flatMap((f) => f.rows);
  const invite = rows.find((r) => r.permission === "members.invite");
  assert.equal(invite?.lock, "notHeld");
  assert.equal(rows.find((r) => r.permission === "message.send")?.lock, null);
});

test("a_changed_row_is_marked_and_a_base_right_says_who_gave_it", () => {
  const draft = draftOf(accountant);
  draft.permissions.add("message.react");
  const rows = familyRows(accountant, draft, { viewerRights: ["message.react", "message.send"], membersBase: ["message.send"] }).flatMap((f) => f.rows);
  assert.equal(rows.find((r) => r.permission === "message.react")?.changed, true);
  assert.equal(rows.find((r) => r.permission === "message.send")?.givenByMembers, true);
});

test("the_guests_role_locks_what_the_ceiling_forbids", () => {
  const guests: R = { id: "g", name: "guests", permissions: ["channel.view"], manageable: true, systemKey: "guests" };
  const rows = familyRows(guests, draftOf(guests), { viewerRights: ["members.view", "channel.view"], membersBase: [] }).flatMap((f) => f.rows);
  assert.equal(rows.find((r) => r.permission === "members.view")?.lock, "ceiling");
  assert.equal(rows.find((r) => r.permission === "channel.view")?.lock, null);
});

test("every_family_of_the_catalogue_is_listed", () => {
  const families = familyRows(accountant, draftOf(accountant), { viewerRights: [], membersBase: [] });
  assert.deepEqual(families.map((f) => f.key), ["space", "channels", "files", "calendars"]);
});

test("a_base_role_is_read_only_in_its_name_and_cannot_be_deleted_or_previewed", () => {
  const members: R = { id: "m", name: "members", permissions: [], manageable: true, systemKey: "members" };
  const access = editorAccess(members, { edition: "enterprise", canManageRoles: true, frozen: false });
  assert.deepEqual(access.tabs, ["rights"]);
  assert.equal(access.canDelete, false);
  assert.equal(access.canPreview, false);
});

test("the_guests_role_has_rights_and_people_but_no_name_tab", () => {
  const guests: R = { id: "g", name: "guests", permissions: [], manageable: true, systemKey: "guests" };
  assert.deepEqual(editorAccess(guests, { edition: "enterprise", canManageRoles: true, frozen: false }).tabs, ["rights", "people"]);
});

test("a_custom_role_the_caller_manages_is_fully_editable", () => {
  const access = editorAccess(accountant, { edition: "enterprise", canManageRoles: true, frozen: false });
  assert.deepEqual(access.tabs, ["rights", "people", "name"]);
  assert.equal(access.editable, true);
  assert.equal(access.canDelete, true);
  assert.equal(access.canPreview, true);
});

test("a_role_above_the_caller_is_read_only", () => {
  const access = editorAccess({ ...accountant, manageable: false }, { edition: "enterprise", canManageRoles: true, frozen: false });
  assert.equal(access.editable, false);
  assert.equal(access.canDelete, false);
  assert.equal(access.canPreview, false);
});

test("a_frozen_space_reads_but_does_not_edit", () => {
  const access = editorAccess(accountant, { edition: "frozen", canManageRoles: true, frozen: true });
  assert.equal(access.editable, false);
  assert.equal(access.canDelete, false);
});

test("a_community_space_offers_no_preview", () => {
  assert.equal(editorAccess(accountant, { edition: "community", canManageRoles: true, frozen: false }).canPreview, false);
});

test("seven_colours_the_server_accepts", () => {
  assert.deepEqual([...COLOUR_CHOICES], ["sky", "mint", "violet", "pink", "peach", "lime", "sun"]);
});

test("used_in_rows_name_the_place_and_its_level_with_the_hidden_ones_last", () => {
  const rows = usedInRowsOf([
    { kind: "channel", id: "c1", name: "compta", hidden: false, level: "contribute" },
    { kind: "file", hidden: true },
    { kind: "file", id: "f1", name: "Factures", hidden: false, level: "read", parentId: undefined },
  ]);
  assert.deepEqual(rows.map((r) => r.label), ["#compta", "Factures", undefined]);
  assert.equal(rows[0].levelKey, "access.level.channel.contribute");
  assert.equal(rows[2].hidden, true);
});

test("giving_a_role_keeps_the_strongest_first_order", () => {
  const ranked = [{ id: "admin" }, { id: "hr" }, { id: "acc" }];
  assert.deepEqual(rolesWith(["acc"], ranked, "hr", true), ["hr", "acc"]);
  assert.deepEqual(rolesWith(["admin", "hr"], ranked, "hr", false), ["admin"]);
  assert.deepEqual(rolesWith(undefined, ranked, "acc", true), ["acc"]);
});

test("an_empty_name_is_not_a_change_the_save_could_send", () => {
  const draft = draftOf(accountant);
  draft.name = "   ";
  assert.equal(changeCount(accountant, draft), 0);
  draft.permissions.add("members.view");
  assert.equal(changeCount(accountant, draft), 1);
});

test("an_empty_name_blocks_the_save_and_says_why", () => {
  const draft = draftOf(accountant);
  assert.equal(saveBlock(draft), null);
  draft.name = " ";
  assert.equal(saveBlock(draft), "nameRequired");
});

test("a_copied_role_gives_its_colour_to_the_new_one", () => {
  const roles = [accountant, { ...accountant, id: "x", colour: undefined }];
  assert.equal(newRoleColour(roles, "acc"), "mint");
  assert.equal(newRoleColour(roles, "x"), "sky");
  assert.equal(newRoleColour(roles, null), "mint");
  assert.equal(newRoleColour(roles, "gone"), "mint");
});

test("the_draft_is_kept_until_the_saved_role_arrives", () => {
  const draft = draftOf(accountant);
  draft.colour = "pink";
  const sig = roleSignature(accountant);
  const mine = { base: sig, draft };
  // Saved, the role not reloaded yet: still the person's draft, no flicker back to the old values.
  assert.equal(editorDraft(mine, accountant), draft);
  // The reloaded role arrives (its signature moved): its values, the draft is let go.
  const saved = { ...accountant, colour: "pink" };
  assert.notEqual(roleSignature(saved), sig);
  assert.equal(editorDraft(mine, saved).colour, "pink");
  assert.equal(editorDraft(null, accountant).colour, "mint");
});
