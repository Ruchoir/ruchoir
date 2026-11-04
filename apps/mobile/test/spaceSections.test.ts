import { test } from "node:test";
import assert from "node:assert/strict";

import { rightsOf, spaceGates } from "@ruchoir/client/permissionsLogic";

import { READY, sectionsFor, type Section } from "../src/logic/spaceSections.ts";

const ALL = { roles: true, groups: true, audit: true, licence: true };
const community = { role: "owner", members: 12, edition: "community" as const };

function view(space: { role: string; myPermissions?: string[]; members?: number; edition?: "community" | "enterprise" | "frozen"; licence?: never }, supported: boolean, extra = {}) {
  const full = { members: 3, edition: "community" as const, ...space };
  return sectionsFor(spaceGates(full.role, rightsOf(full)), supported, full, { ready: ALL, ...extra });
}
const keys = (list: Section[]) => list.map((s) => s.key);

test("an_owner_sees_the_six_sections_in_order", () => {
  assert.deepEqual(keys(view(community, true)), ["general", "members", "roles", "groups", "audit", "licence"]);
});

test("a_role_with_members_view_and_audit_view_sees_only_those", () => {
  const accountant = { role: "member", myPermissions: ["members.view", "audit.view"] };
  assert.deepEqual(keys(view(accountant, true)), ["members", "audit"]);
});

test("a_role_that_sets_the_space_up_reaches_general", () => {
  assert.deepEqual(keys(view({ role: "member", myPermissions: ["space.settings"] }, true)), ["general"]);
  assert.deepEqual(keys(view({ role: "member", myPermissions: ["groups.manage"] }, true)), ["groups"]);
});

test("an_older_server_keeps_todays_two_tabs", () => {
  assert.deepEqual(keys(view({ role: "admin" }, false)), ["general", "members"]);
  assert.deepEqual(keys(view({ role: "owner" }, false)), ["general", "members"]);
  assert.deepEqual(keys(view({ role: "member" }, false)), ["general"]);
  assert.deepEqual(keys(view({ role: "guest" }, false)), ["general"]);
});

test("the_licence_is_the_owners_and_needs_an_instance_with_licences", () => {
  assert.ok(!keys(view({ role: "admin" }, true)).includes("licence"));
  assert.ok(!keys(view(community, true, { licences: false })).includes("licence"));
});

test("every_section_is_built_and_listed_by_default", () => {
  assert.deepEqual(READY, { roles: true, groups: true, audit: true, licence: true });
  const space = { ...community };
  const list = sectionsFor(spaceGates("owner", rightsOf(space)), true, space);
  assert.deepEqual(keys(list), ["general", "members", "roles", "groups", "audit", "licence"]);
});

test("the_lines_say_the_counts", () => {
  const list = view(community, true, { counts: { people: 12, guests: 3, roles: 5, customRoles: 2, groups: 4 } });
  const line = (k: string) => list.find((s) => s.key === k)!.line;
  assert.deepEqual(line("members"), [
    { key: "details.membersCount", vars: { count: 12 } },
    { key: "event.invited", vars: { count: 3 } },
  ]);
  assert.deepEqual(line("roles"), [
    { key: "spaceSections.rolesCount", vars: { count: 5 } },
    { key: "spaceSections.rolesCustom", vars: { count: 2 } },
  ]);
  assert.deepEqual(line("groups"), [{ key: "spaceSections.groupsCount", vars: { count: 4 } }]);
  assert.deepEqual(line("general"), [{ key: "spaceSections.generalLine" }]);
});

test("without_counts_the_members_line_uses_the_spaces_own_figure_and_no_guests", () => {
  const list = view(community, true);
  assert.deepEqual(list.find((s) => s.key === "members")!.line, [{ key: "details.membersCount", vars: { count: 12 } }]);
  assert.deepEqual(list.find((s) => s.key === "roles")!.line, [{ key: "spaceSections.rolesLine" }]);
});

test("the_licence_line_reads_edition_and_seats", () => {
  const enterprise = view(
    { ...community, edition: "enterprise", licence: { seats: 25, used: 12, validUntil: "2027-01-01T00:00:00Z", expiresInDays: 200 } as never },
    true,
  );
  assert.deepEqual(enterprise.find((s) => s.key === "licence")!.line, [{ key: "spaceSections.licenceSeats", vars: { used: 12, seats: 25 } }]);
  assert.deepEqual(enterprise.find((s) => s.key === "audit")!.line, [{ key: "spaceSections.auditLine" }]);
  const bare = view({ ...community, edition: "enterprise" }, true);
  assert.deepEqual(bare.find((s) => s.key === "licence")!.line, [{ key: "spaceSections.licenceEnterprise" }]);
  const frozen = view({ ...community, edition: "frozen" }, true);
  assert.deepEqual(frozen.find((s) => s.key === "licence")!.line, [{ key: "spaceSections.licenceFrozen" }]);
  const free = view(community, true);
  assert.deepEqual(free.find((s) => s.key === "licence")!.line, [{ key: "spaceSections.licenceCommunity" }]);
  assert.deepEqual(free.find((s) => s.key === "audit")!.line, [{ key: "spaceSections.auditCommunity" }]);
});

test("the_journal_line_names_the_last_change_when_the_space_has_a_licence", () => {
  const enterprise = { role: "owner", members: 12, edition: "enterprise" as const };
  const line = (list: Section[]) => list.find((s) => s.key === "audit")!.line;
  assert.deepEqual(line(view(enterprise, true, { counts: { lastChange: { day: "hier", time: "16:42" } } })), [
    { key: "spaceSections.auditLast", vars: { day: "hier", time: "16:42" } },
  ]);
  assert.deepEqual(line(view(enterprise, true)), [{ key: "spaceSections.auditLine" }]);
  // A community space keeps its thirty days, whatever the log says.
  assert.deepEqual(line(view(community, true, { counts: { lastChange: { day: "hier", time: "16:42" } } })), [{ key: "spaceSections.auditCommunity" }]);
});
