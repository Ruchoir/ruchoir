import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { ApiError, createClient, refusalOf, resetClientForTests } from "../src/index.ts";
import { fakeFetch } from "./fakeFetch.ts";

beforeEach(() => resetClientForTests());

const api = () => createClient({ baseUrl: "https://a.test" });
const path = (url: string) => url.replace("https://a.test/api/v1", "");

const accessDto = {
  resource: { kind: "file", id: "f1", name: "Plan.docx", parent: { kind: "file", id: "d1", name: "Docs", hidden: false } },
  private: false,
  archived: false,
  entries: [
    {
      id: "r1", target: { kind: "group", id: "g1", name: "Design" }, level: "contribute",
      allow: ["files.write"], deny: [], clamped: true, guest: false, via_legacy: false,
    },
    {
      id: null, target: { kind: "everyone", name: "Members" }, level: "custom", allow: [], deny: ["files.delete"],
      clamped: false, guest: false, via_legacy: true,
      inherited_from: { kind: "file", hidden: true },
      summary: { nearest: "read", changes: [{ permission: "files.delete", state: "deny" }] },
    },
  ],
  may: { edit: true, fine: false, manage_target_levels: ["read", "contribute"], held: ["files.view", "files.edit"], reason: null },
};

test("access_maps_from_the_wire", async () => {
  const calls = fakeFetch({ body: accessDto });
  const view = await api().getAccess("s1", "file", "f1");
  assert.ok(calls[0].url.endsWith("/api/v1/spaces/s1/access/file/f1"));
  assert.deepEqual(view, {
    resource: { kind: "file", id: "f1", name: "Plan.docx", parent: { kind: "file", id: "d1", name: "Docs", hidden: false } },
    private: false,
    archived: false,
    entries: [
      {
        id: "r1", target: { kind: "group", id: "g1", name: "Design", hidden: false }, level: "contribute",
        allow: ["files.write"], deny: [], clamped: true, guest: false, viaLegacy: false,
        inheritedFrom: undefined, summary: undefined,
      },
      {
        id: undefined, target: { kind: "everyone", id: undefined, name: "Members", hidden: false }, level: "custom",
        allow: [], deny: ["files.delete"], clamped: false, guest: false, viaLegacy: true,
        inheritedFrom: { kind: "file", id: undefined, name: undefined, hidden: true },
        summary: { nearest: "read", changes: [{ permission: "files.delete", state: "deny" }] },
      },
    ],
    may: { edit: true, fine: false, manageTargetLevels: ["read", "contribute"], held: ["files.view", "files.edit"], reason: undefined },
  });
});

test("an_unknown_level_reads_as_custom", async () => {
  fakeFetch({ body: { ...accessDto, entries: [{ ...accessDto.entries[0], level: "weird" }] } });
  const view = await api().getAccess("s1", "channel", "c1");
  assert.equal(view.entries[0].level, "custom");
});

test("access_writes_send_what_the_routes_expect", async () => {
  const calls = fakeFetch({ body: accessDto }, { status: 204 });
  const client = api();
  const view = await client.setAccessLevel("s1", "calendar", "k1", { kind: "user", id: "u1" }, "read");
  await client.removeAccessEntry("s1", "calendar", "k1", "r1");
  assert.equal(view.resource.id, "f1");
  assert.deepEqual(calls.map((c) => [c.init.method, path(c.url)]), [
    ["PUT", "/spaces/s1/access/calendar/k1/entries"],
    ["DELETE", "/spaces/s1/access/calendar/k1/entries/r1"],
  ]);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { target: { kind: "user", id: "u1" }, level: "read" });
});

test("why_maps_from_the_wire", async () => {
  const calls = fakeFetch({
    body: {
      person: { id: "u1", name: "Ana", standing: "guest" },
      steps: [
        { n: 1, kind: "role", permission: "files.read", effect: "granted",
          role: { id: "r2", name: "Design", direct: false, via_groups: [{ id: "g1", name: "Studio" }] } },
        { n: 2, kind: "rule", permission: "files.write", effect: "removed",
          target: { kind: "user", id: "u1", name: "Ana" }, level: { kind: "file", id: "d1", name: "Docs" }, rule_level: "custom" },
      ],
      result: [{ permission: "files.read", granted: true, reason: { n: 1 } }, { permission: "files.write", granted: false }],
    },
  });
  const why = await api().explainAccess("s1", "file", "f1", "u1");
  assert.ok(calls[0].url.endsWith("/api/v1/spaces/s1/access/file/f1/why?user_id=u1"));
  assert.deepEqual(why.person, { id: "u1", name: "Ana", standing: "guest" });
  assert.deepEqual(why.steps[0].role, { id: "r2", name: "Design", direct: false, viaGroups: [{ id: "g1", name: "Studio" }] });
  assert.equal(why.steps[1].effect, "removed");
  assert.equal(why.steps[1].target?.name, "Ana");
  assert.equal(why.steps[1].level?.name, "Docs");
  assert.equal(why.steps[1].ruleLevel, "custom");
  assert.equal(why.steps[0].ruleLevel, undefined);
  assert.deepEqual(why.result, [
    { permission: "files.read", granted: true, reasonStep: 1 },
    { permission: "files.write", granted: false, reasonStep: undefined },
  ]);
});

test("why_without_a_person_explains_the_caller", async () => {
  const calls = fakeFetch({ body: { person: { id: "me", name: "Moi", standing: "owner" }, steps: [], result: [] } });
  await api().explainAccess("s1", "channel", "c1");
  assert.ok(calls[0].url.endsWith("/api/v1/spaces/s1/access/channel/c1/why"));
});

test("a_space_carries_its_preview", async () => {
  const space = { id: "s1", name: "A", slug: "a", role: "member", members: 2, unread: 0, mentions: 0, edition: "enterprise" };
  fakeFetch({ body: [{ ...space, preview: { role_id: "r2", role_name: "Design" } }, { ...space, id: "s2", preview: null }] });
  const [previewed, plain] = await api().getWorkspaces();
  assert.deepEqual(previewed.preview, { roleId: "r2", roleName: "Design" });
  assert.equal(plain.preview, undefined);
});

test("the_preview_routes", async () => {
  const calls = fakeFetch({ status: 200, body: { space_id: "s1", role_id: "r2", role_name: "Design", idle_seconds: 1800 } }, { status: 204 });
  const client = api();
  const started = await client.startPreview("s1", "r2");
  await client.quitPreview("s1");
  assert.deepEqual(started, { roleId: "r2", roleName: "Design", idleSeconds: 1800 });
  assert.deepEqual(calls.map((c) => [c.init.method, path(c.url)]), [
    ["POST", "/spaces/s1/roles/r2/preview"],
    ["DELETE", "/spaces/s1/preview"],
  ]);
});

test("access_refusals_are_named", () => {
  const refusal = (status: number, body: unknown) => refusalOf(new ApiError(status, "x", body));
  for (const code of ["cannot_grant", "target_above_you", "reservation_admins_only"]) {
    assert.deepEqual(refusal(403, { error: "forbidden", reason: code }), { code });
  }
  for (const code of ["guest_ceiling", "not_in_space", "audience_files_only", "base_role_not_previewable", "unknown_permission", "wrong_family"]) {
    assert.deepEqual(refusal(400, { error: code }), { code });
  }
  assert.deepEqual(refusal(403, { error: "preview_read_only" }), { code: "preview_read_only" });
  assert.deepEqual(refusal(503, { error: "preview_unavailable" }), { code: "preview_unavailable" });
  assert.deepEqual(refusal(409, { error: "licence_frozen" }), { code: "licence_frozen" });
  assert.deepEqual(refusal(402, { error: "licence_required", pricing_url: "https://p.test" }), { code: "licence_required", pricingUrl: "https://p.test" });
});

test("rule_refusals_name_where_a_group_or_role_is_used", () => {
  const refusal = (body: unknown) => refusalOf(new ApiError(409, "x", body));
  const used = refusal({
    error: "group_has_rules",
    used_in: [{ kind: "channel", id: "c1", name: "General", level: "contribute" }, { kind: "file", id: "f1", name: "Plan", level: "custom", parent_id: "d1" }, { kind: "file", hidden: true }],
  });
  assert.deepEqual(used, {
    code: "group_has_rules",
    usedIn: [
      { kind: "channel", id: "c1", name: "General", hidden: false, level: "contribute", parentId: undefined },
      { kind: "file", id: "f1", name: "Plan", hidden: false, level: "custom", parentId: "d1" },
      { kind: "file", id: undefined, name: undefined, hidden: true, level: undefined, parentId: undefined },
    ],
  });
  assert.deepEqual(refusal({ error: "role_has_rules" }), { code: "role_has_rules" });
  assert.deepEqual(refusal({ error: "role_has_rules", used_in: [] }), { code: "role_has_rules", usedIn: [] });
});

test("a_fine_rule_is_written_to_the_rules_route", async () => {
  const calls = fakeFetch({ body: accessDto }, { body: accessDto });
  const client = api();
  const view = await client.setAccessRule("s1", "channel", "c1", { kind: "group", id: "g1" }, { allow: ["message.pin"], deny: ["message.mention_all"] });
  await client.setAccessRule("s1", "channel", "c1", { kind: "user", id: "u1" }, { allow: [], deny: [] });
  assert.equal(calls[0].init.method, "PUT");
  assert.equal(path(calls[0].url), "/spaces/s1/access/channel/c1/rules");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    target: { kind: "group", id: "g1" },
    allow: ["message.pin"],
    deny: ["message.mention_all"],
  });
  assert.equal(view.resource.id, "f1");
  assert.deepEqual(JSON.parse(String(calls[1].init.body)).allow, []);
});

test("the_fine_rule_refusals_are_named", () => {
  const refusal = (status: number, body: unknown) => refusalOf(new ApiError(status, "x", body));
  assert.deepEqual(refusal(400, { error: "base_role_levels_only" }), { code: "base_role_levels_only" });
  assert.deepEqual(refusal(400, { error: "permission_in_both" }), { code: "permission_in_both" });
});

test("the_dialog_carries_what_the_editor_holds", async () => {
  fakeFetch({ body: accessDto }, { body: { ...accessDto, may: { edit: false, fine: false, manage_target_levels: [], reason: "not_allowed" } } });
  const client = api();
  assert.deepEqual((await client.getAccess("s1", "file", "f1")).may.held, ["files.view", "files.edit"]);
  // An older server sends none: nothing is held.
  assert.deepEqual((await client.getAccess("s1", "file", "f1")).may.held, []);
});
