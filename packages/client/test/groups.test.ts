import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { ApiError, createClient, refusalOf, resetClientForTests } from "../src/index.ts";
import { fakeFetch } from "./fakeFetch.ts";

beforeEach(() => resetClientForTests());

const api = () => createClient({ baseUrl: "https://a.test" });

const dto = {
  id: "g1", name: "Design", description: "The design team", source: "manual",
  member_ids: ["u1", "u2"], manager_ids: ["u1"], role_ids: ["r2"],
  may: { edit: true, delete: false, change_members: true, change_roles: false, appoint: true, add_needs_licence: true, add_people_needs_licence: true },
};

test("groups_map_from_the_wire", async () => {
  const calls = fakeFetch({
    body: [dto, { ...dto, id: "g2", name: "Annuaire", description: null, source: "directory", manager_ids: [], role_ids: [] }],
  });
  const [design, annuaire] = await api().listGroups("s1");
  assert.ok(calls[0].url.endsWith("/api/v1/spaces/s1/groups"));
  assert.deepEqual(design, {
    id: "g1", name: "Design", description: "The design team", source: "manual",
    memberIds: ["u1", "u2"], managerIds: ["u1"], roleIds: ["r2"],
    may: { edit: true, delete: false, changeMembers: true, changeRoles: false, appoint: true, addNeedsLicence: true, addPeopleNeedsLicence: true },
  });
  assert.equal(annuaire.description, undefined);
  assert.equal(annuaire.source, "directory");
});

test("members_carry_their_groups", async () => {
  fakeFetch({ body: [{ user_id: "u1", display_name: "Hugo", role: "member", is_bot: false, group_ids: ["g1"] }, { user_id: "u2", display_name: "Ana", role: "member", is_bot: false }] });
  const [hugo, ana] = await api().getSpaceMembers("s1");
  assert.deepEqual(hugo.groupIds, ["g1"]);
  assert.equal(ana.groupIds, undefined);
});

test("group_writes_send_what_the_routes_expect", async () => {
  const calls = fakeFetch(
    { status: 201, body: dto }, { body: dto }, { status: 204 }, { body: dto },
    { status: 204 }, { body: dto }, { body: dto },
  );
  const client = api();
  const created = await client.createGroup("s1", { name: "Design", description: "The design team" });
  await client.updateGroup("s1", "g1", { name: "Studio" });
  await client.deleteGroup("s1", "g1");
  await client.addGroupMembers("s1", "g1", ["u3"]);
  await client.removeGroupMember("s1", "g1", "u3");
  await client.setGroupRoles("s1", "g1", ["r2"]);
  await client.setGroupManagers("s1", "g1", ["u1"]);
  assert.equal(created.id, "g1");
  assert.deepEqual(calls.map((c) => [c.init.method, c.url.replace("https://a.test/api/v1", "")]), [
    ["POST", "/spaces/s1/groups"],
    ["PATCH", "/spaces/s1/groups/g1"],
    ["DELETE", "/spaces/s1/groups/g1"],
    ["POST", "/spaces/s1/groups/g1/members"],
    ["DELETE", "/spaces/s1/groups/g1/members/u3"],
    ["PUT", "/spaces/s1/groups/g1/roles"],
    ["PUT", "/spaces/s1/groups/g1/managers"],
  ]);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { name: "Design", description: "The design team" });
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), { name: "Studio" });
  assert.deepEqual(JSON.parse(String(calls[3].init.body)), { user_ids: ["u3"] });
  assert.deepEqual(JSON.parse(String(calls[5].init.body)), { role_ids: ["r2"] });
  assert.deepEqual(JSON.parse(String(calls[6].init.body)), { user_ids: ["u1"] });
});

test("group_refusals_are_named", () => {
  const refusal = (status: number, body: unknown) => refusalOf(new ApiError(status, "x", body));
  for (const code of ["no_self_role", "manager_protected"]) {
    assert.deepEqual(refusal(403, { error: "forbidden", reason: code }), { code });
  }
  for (const [status, code] of [
    [409, "group_from_directory"], [409, "group_name_taken"], [400, "group_name_reserved"],
    [400, "group_name_invalid"], [400, "manager_must_be_member"], [400, "base_role_not_allowed"],
    [400, "not_in_space"], [400, "too_many_people"],
  ] as const) {
    assert.deepEqual(refusal(status, { error: code }), { code });
  }
});
