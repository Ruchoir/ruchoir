import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { createClient, resetClientForTests } from "../src/index.ts";
import { licenceRows } from "../src/permissionsLogic/index.ts";
import { fakeFetch } from "./fakeFetch.ts";

beforeEach(() => resetClientForTests());

test("the_instance_administrator_reads_every_spaces_licence", async () => {
  const calls = fakeFetch({
    body: [
      { space_id: "s1", space_name: "Atelier", organisation: "Atelier SARL", seats: 25, used: 8, valid_until: "2027-01-31T23:59:59Z", edition: "enterprise" },
      { space_id: "s2", space_name: "Cabinet", organisation: "Cabinet Dubois", seats: 5, used: 6, valid_until: "2026-10-01T23:59:59Z", edition: "frozen" },
    ],
  });
  const list = await createClient({ baseUrl: "https://a.test" }).getAdminLicences();
  assert.equal(new URL(calls[0].url).pathname, "/api/v1/admin/licences");
  assert.deepEqual(list[0], {
    spaceId: "s1", spaceName: "Atelier", organisation: "Atelier SARL", seats: 25, used: 8, validUntil: "2027-01-31T23:59:59Z", edition: "enterprise",
  });
  assert.equal(list[1].edition, "frozen");
});

test("licences_are_listed_by_soonest_expiry_with_days_left_and_frozen", () => {
  const rows = licenceRows(
    [
      { spaceId: "a", spaceName: "A", organisation: "A", seats: 5, used: 1, validUntil: "2027-06-01T00:00:00Z", edition: "enterprise" },
      { spaceId: "b", spaceName: "B", organisation: "B", seats: 5, used: 6, validUntil: "2026-10-01T00:00:00Z", edition: "frozen" },
      { spaceId: "c", spaceName: "C", organisation: "C", seats: 5, used: 2, validUntil: "2026-11-14T12:00:00Z", edition: "enterprise" },
    ],
    new Date("2026-11-04T10:00:00Z"),
    "Europe/Paris",
  );
  assert.deepEqual(rows.map((r) => r.spaceId), ["b", "c", "a"]);
  assert.deepEqual(rows.map((r) => r.daysLeft), [0, 10, 209]);
  assert.deepEqual(rows.map((r) => r.frozen), [true, false, false]);
  assert.equal(rows[1].soon, true, "within the 30 days the owners are mailed at");
  assert.equal(rows[2].soon, false);
});

test("a_change_of_rights_carries_the_end_date_and_the_preview_too", async () => {
  const { applyRights } = await import("../src/permissionsLogic/index.ts");
  const old = { id: "s", name: "S", role: "guest", expiresAt: "2026-11-10T00:00:00Z", unread: 4, edition: "community" } as never;
  const fresh = { id: "s", name: "S", role: "member", myPermissions: ["files.view"], edition: "enterprise", unread: 0, preview: { roleId: "r", roleName: "R" } } as never;
  const merged = applyRights(old, fresh) as Record<string, unknown>;
  assert.equal(merged.role, "member");
  assert.equal(merged.expiresAt, undefined, "a guest made member has no end date any more");
  assert.deepEqual(merged.preview, { roleId: "r", roleName: "R" });
  assert.deepEqual(merged.myPermissions, ["files.view"]);
  assert.equal(merged.unread, 4, "the counters stay what this client holds");
});

test("the_owner_is_warned_in_the_settings_when_the_licence_ends_within_30_days_or_is_frozen", async () => {
  const { spaceLicenceBanner } = await import("../src/permissionsLogic/index.ts");
  const licence = (expiresInDays: number) => ({ seats: 5, used: 1, validUntil: "2026-12-01T00:00:00Z", expiresInDays });
  assert.deepEqual(spaceLicenceBanner({ role: "owner", edition: "enterprise", licence: licence(30) }), { kind: "ends", tone: "warning", days: 30 });
  assert.deepEqual(spaceLicenceBanner({ role: "owner", edition: "enterprise", licence: licence(7) }), { kind: "ends", tone: "danger", days: 7 });
  assert.equal(spaceLicenceBanner({ role: "owner", edition: "enterprise", licence: licence(31) }), null);
  assert.deepEqual(spaceLicenceBanner({ role: "owner", edition: "frozen", licence: licence(0) }), { kind: "frozen" });
  assert.equal(spaceLicenceBanner({ role: "admin", edition: "frozen" }), null, "the owners alone are told");
  assert.equal(spaceLicenceBanner({ role: "owner", edition: "community" }), null);
});
