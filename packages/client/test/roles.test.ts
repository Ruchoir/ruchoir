import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { ApiError, createClient, refusalOf, resetClientForTests } from "../src/index.ts";
import { fakeFetch } from "./fakeFetch.ts";

beforeEach(() => resetClientForTests());

const api = () => createClient({ baseUrl: "https://a.test" });

test("a_space_says_its_edition_and_its_licence", async () => {
  fakeFetch({
    body: [
      {
        id: "s1", name: "Atelier", slug: "atelier", role: "owner", members: 8, unread: 0, mentions: 0,
        edition: "enterprise",
        licence: { seats: 25, used: 8, valid_until: "2027-12-31T23:59:59Z", expires_in_days: 420 },
      },
      { id: "s2", name: "Ancien", slug: "ancien", role: "member", members: 2, unread: 0, mentions: 0 },
    ],
  });
  const [licensed, older] = await api().getWorkspaces();
  assert.equal(licensed.edition, "enterprise");
  assert.deepEqual(licensed.licence, { seats: 25, used: 8, validUntil: "2027-12-31T23:59:59Z", expiresInDays: 420 });
  assert.equal(older.edition, "community", "an older instance runs the community edition");
  assert.equal(older.licence, undefined);
});

test("roles_are_read_strongest_first_with_what_they_grant", async () => {
  const calls = fakeFetch({
    body: [
      { id: "r1", system_key: "administrator", name: "Administrator", position: 3, permissions: ["members.view"], holders: 1, manageable: false },
      { id: "r2", name: "Comptable", colour: "mint", position: 2, permissions: ["files.manage"], holders: 2, manageable: true },
    ],
  });
  const roles = await api().listRoles("s1");
  assert.ok(calls[0].url.endsWith("/api/v1/spaces/s1/roles"));
  assert.deepEqual(roles[1], { id: "r2", systemKey: undefined, name: "Comptable", colour: "mint", position: 2, permissions: ["files.manage"], holders: 2, manageable: true });
  assert.equal(roles[0].systemKey, "administrator");
});

test("members_carry_their_roles_and_whether_one_may_manage_them", async () => {
  fakeFetch({ body: [{ user_id: "u1", display_name: "Hugo", role: "member", is_bot: false, role_ids: ["r2"], manageable: true, joined_at: "2026-03-12T09:00:00Z" }] });
  const [hugo] = await api().getSpaceMembers("s1");
  assert.deepEqual(hugo.roleIds, ["r2"]);
  assert.equal(hugo.manageable, true);
  assert.equal(hugo.joinedAt, "2026-03-12T09:00:00Z");
});

test("role_writes_send_what_the_routes_expect", async () => {
  const role = { id: "r9", name: "Délégué", position: 1, permissions: [], holders: 0, manageable: true };
  const calls = fakeFetch({ status: 201, body: role }, { body: role }, { status: 204 }, { body: [role] }, { body: { user_id: "u1", role_ids: ["r9"] } });
  const client = api();
  await client.createRole("s1", { name: "Délégué", colour: "lime", copyFrom: "r2" });
  await client.updateRole("s1", "r9", { permissions: ["members.invite"] });
  await client.deleteRole("s1", "r9");
  await client.orderRoles("s1", ["r1", "r9"]);
  const set = await client.setMemberRoles("s1", "u1", ["r9"]);
  assert.deepEqual(calls.map((c) => [c.init.method, c.url.replace("https://a.test/api/v1", "")]), [
    ["POST", "/spaces/s1/roles"],
    ["PATCH", "/spaces/s1/roles/r9"],
    ["DELETE", "/spaces/s1/roles/r9"],
    ["PUT", "/spaces/s1/roles/order"],
    ["PUT", "/spaces/s1/members/u1/roles"],
  ]);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { name: "Délégué", colour: "lime", copy_from: "r2" });
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), { permissions: ["members.invite"] });
  assert.deepEqual(JSON.parse(String(calls[3].init.body)), { role_ids: ["r1", "r9"] });
  assert.deepEqual(set, ["r9"]);
});

test("the_audit_log_is_read_a_page_at_a_time", async () => {
  const calls = fakeFetch({
    body: {
      entries: [{ id: "e1", at: "2026-11-03T14:32:00Z", action: "member.roles_changed", category: "members", actor: { id: "u0", display_name: "Karim" }, target: { kind: "member", id: "u1", label: "Hugo" }, details: { after: [] } }],
      next: "123_abc",
    },
  });
  const page = await api().getAudit("s1", { actor: "u0", category: "members", since: "2026-10-01T00:00:00Z", before: "999_x", limit: 50 });
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/api/v1/spaces/s1/audit");
  assert.deepEqual(Object.fromEntries(url.searchParams), { actor: "u0", category: "members", since: "2026-10-01T00:00:00Z", before: "999_x", limit: "50" });
  assert.equal(page.next, "123_abc");
  assert.deepEqual(page.entries[0].actor, { id: "u0", name: "Karim", avatarUrl: undefined });
  assert.equal(page.entries[0].target.label, "Hugo");
});

test("a_licence_is_installed_read_and_removed", async () => {
  const view = { licence_id: "l1", organisation: "Atelier SARL", seats: 25, used: 8, valid_until: "2027-12-31T23:59:59Z", edition: "enterprise" };
  const calls = fakeFetch({ body: view }, { body: view }, { status: 404, body: { error: "not_found" } }, { status: 204 });
  const client = api();
  const installed = await client.putLicence("s1", "RUCHOIR-LICENCE-1.x.y");
  assert.equal(installed.organisation, "Atelier SARL");
  assert.equal(installed.validUntil, "2027-12-31T23:59:59Z");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { licence: "RUCHOIR-LICENCE-1.x.y" });
  assert.equal((await client.getLicence("s1"))?.seats, 25);
  assert.equal(await client.getLicence("s1"), null);
  await client.deleteLicence("s1");
  assert.equal(calls[3].init.method, "DELETE");
});

test("each_refusal_is_named", () => {
  const refusal = (status: number, body: unknown) => refusalOf(new ApiError(status, "x", body));
  assert.deepEqual(refusal(402, { error: "seats_full", seats: 7, pricing_url: "https://p" }), { code: "seats_full", pricingUrl: "https://p", seats: 7 });
  assert.deepEqual(refusal(402, { error: "licence_required", pricing_url: "https://p" }), { code: "licence_required", pricingUrl: "https://p" });
  assert.deepEqual(refusal(409, { error: "licence_frozen" }), { code: "licence_frozen" });
  assert.deepEqual(refusal(422, { error: "licence_other_space", organisation: "Cabinet Dubois" }), { code: "licence_other_space", organisation: "Cabinet Dubois" });
  assert.deepEqual(refusal(403, { error: "forbidden", reason: "role_above_you" }), { code: "role_above_you" });
  assert.deepEqual(refusal(409, { error: "role_name_taken" }), { code: "role_name_taken" });
  assert.equal(refusal(403, { error: "forbidden" }), undefined);
  assert.equal(refusalOf(new Error("network")), undefined);
});
