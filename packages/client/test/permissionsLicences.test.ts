import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { createClient, resetClientForTests } from "../src/index.ts";
import { applyChannelRights, licenceRows } from "../src/permissionsLogic/index.ts";
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
  const now = new Date("2026-11-01T10:00:00Z");
  const licence = (days: number) => ({ seats: 5, used: 1, validUntil: new Date(now.getTime() + days * 86400000).toISOString(), expiresInDays: days });
  const banner = (space: Parameters<typeof spaceLicenceBanner>[0]) => spaceLicenceBanner(space, now, "UTC");
  assert.deepEqual(banner({ role: "owner", edition: "enterprise", licence: licence(30) }), { kind: "ends", tone: "warning", days: 30 });
  assert.deepEqual(banner({ role: "owner", edition: "enterprise", licence: licence(7) }), { kind: "ends", tone: "danger", days: 7 });
  assert.equal(banner({ role: "owner", edition: "enterprise", licence: licence(31) }), null);
  assert.deepEqual(banner({ role: "owner", edition: "frozen", licence: licence(0) }), { kind: "frozen" });
  assert.equal(banner({ role: "admin", edition: "frozen" }), null, "the owners alone are told");
  assert.equal(banner({ role: "owner", edition: "community" }), null);
});

test("an_unreadable_licence_is_listed_last_flagged_and_never_throws", () => {
  const base = { organisation: "X", seats: 5, used: 1 };
  const rows = licenceRows(
    [
      { ...base, spaceId: "bad", spaceName: "Bad", validUntil: "not a date", edition: "invalid" },
      { ...base, spaceId: "empty", spaceName: "Empty", validUntil: "", edition: "enterprise" },
      { ...base, spaceId: "ok", spaceName: "Ok", validUntil: "2026-11-14T12:00:00Z", edition: "enterprise" },
      { ...base, spaceId: "inv", spaceName: "Inv", validUntil: "2026-12-01T12:00:00Z", edition: "invalid" },
    ],
    new Date("2026-11-04T10:00:00Z"),
    "Europe/Paris",
  );
  assert.deepEqual(rows.map((r) => r.spaceId).slice(0, 2), ["ok", "inv"]);
  assert.deepEqual(new Set(rows.slice(2).map((r) => r.spaceId)), new Set(["bad", "empty"]));
  const byId = Object.fromEntries(rows.map((r) => [r.spaceId, r]));
  assert.equal(byId.bad.unreadable, true);
  assert.equal(byId.empty.unreadable, true);
  assert.equal(byId.inv.unreadable, true, "an invalid edition cannot be trusted either");
  assert.equal(byId.ok.unreadable, false);
  assert.ok(Number.isNaN(byId.bad.daysLeft) && Number.isNaN(byId.empty.daysLeft));
  assert.equal(byId.bad.soon, false);
});

test("a_channel_list_read_after_a_role_edit_keeps_what_only_this_client_knows", () => {
  const held = [
    { id: "a", name: "A", fav: true, unread: 3, type: "public", myPermissions: ["message.send"], lastMessage: { body: "live" } },
    { id: "gone", name: "Gone", fav: false, unread: 0, type: "public" },
  ] as never[];
  const fresh = [
    { id: "b", name: "B", fav: false, unread: 0, type: "public", myPermissions: ["channel.view"] },
    { id: "a", name: "A2", fav: false, unread: 0, type: "public", myPermissions: ["message.send", "message.pin"], member: true },
  ] as never[];
  const out = applyChannelRights(held, fresh) as any[];
  // The server's order and set, the rights and the rest from the server; favourite, unread and last message from here.
  assert.deepEqual(out.map((c) => c.id), ["b", "a"]);
  assert.deepEqual(out[1].myPermissions, ["message.send", "message.pin"]);
  assert.equal(out[1].name, "A2");
  assert.equal(out[1].member, true);
  assert.equal(out[1].fav, true);
  assert.equal(out[1].unread, 3);
  assert.deepEqual(out[1].lastMessage, { body: "live" });
  assert.equal(out[0].unread, 0);
});

test("one_rule_for_the_days_left_of_a_licence_banner_and_list_alike", async () => {
  const { spaceLicenceBanner, licenceRows } = await import("../src/permissionsLogic/index.ts");
  // Ends 16 November 00:00 UTC, seen on 5 November 00:27 in Paris: the 16th is the 11th day after the 5th.
  const now = new Date("2026-11-04T23:27:00Z");
  const zone = "Europe/Paris";
  const validUntil = "2026-11-16T00:00:00Z";
  const banner = spaceLicenceBanner({ role: "owner", edition: "enterprise", licence: { seats: 5, used: 1, validUntil, expiresInDays: 12 } }, now, zone);
  const row = licenceRows([{ organisation: "X", seats: 5, used: 1, spaceId: "s", spaceName: "S", validUntil, edition: "enterprise" }], now, zone)[0];
  assert.equal(row?.daysLeft, 11);
  assert.deepEqual(banner, { kind: "ends", tone: "warning", days: 11 });
  // The warning window follows the same count: 30 days in the zone shows, 31 does not.
  const at = (d: string) => spaceLicenceBanner({ role: "owner", edition: "enterprise", licence: { seats: 5, used: 1, validUntil: d, expiresInDays: 99 } }, now, zone);
  assert.equal(at("2026-12-05T10:00:00Z")?.kind, "ends");
  assert.equal(at("2026-12-06T10:00:00Z"), null);
});

test("the_licence_detail_line_names_the_holder_only_when_it_differs_and_says_unreadable_once", async () => {
  const { licenceDetail } = await import("../src/permissionsLogic/index.ts");
  const row = { organisation: "Cabinet Morel", spaceName: "Cabinet Morel" };
  assert.deepEqual(licenceDetail(row, ["Entreprise", "1 sur 10 places", "5 nov. 2026"]), ["Entreprise", "1 sur 10 places", "5 nov. 2026"]);
  assert.deepEqual(licenceDetail({ ...row, organisation: " cabinet morel " }, ["Entreprise"]), ["Entreprise"]);
  assert.deepEqual(licenceDetail({ ...row, organisation: "Morel SAS" }, ["Entreprise"]), ["Morel SAS", "Entreprise"]);
  assert.deepEqual(licenceDetail({ ...row, organisation: "" }, ["Entreprise"]), ["Entreprise"]);
  assert.deepEqual(licenceDetail(row, ["Illisible", "1 sur 10 places", "Illisible"]), ["Illisible", "1 sur 10 places"]);
});

import { licenceStanding } from "../src/permissionsLogic/index.ts";
import type { LicenceView } from "../src/types.ts";

const online = (over: Partial<LicenceView> = {}): LicenceView => ({
  licenceId: "l", organisation: "Atelier", seats: 25, used: 8, validUntil: "2027-11-04T00:00:00Z", edition: "enterprise",
  mode: "online", status: "active", lastCheckInAt: "2026-11-05T14:00:00Z", ...over,
});

test("an_active_online_licence_shows_its_mode_check_in_and_the_check_button", () => {
  const s = licenceStanding(online());
  assert.deepEqual(s.tag, { tone: "success", key: "licence.tag.active" });
  assert.equal(s.modeKey, "licence.mode.online");
  assert.equal(s.banner, null);
  assert.equal(s.canCheck, true);
  assert.equal(s.lastCheckInAt, "2026-11-05T14:00:00Z");
  assert.equal(s.next, null);
});

test("each_status_has_its_tag_and_banner", () => {
  assert.deepEqual(licenceStanding(online({ status: "suspended", edition: "frozen" })).banner, { tone: "warning", key: "licence.banner.suspended" });
  assert.deepEqual(licenceStanding(online({ status: "revoked", edition: "frozen" })).banner, { tone: "danger", key: "licence.banner.revoked" });
  assert.deepEqual(
    licenceStanding(online({ status: "unreachable", edition: "frozen", unreachableSince: "2026-10-28T14:05:00Z" })).banner,
    { tone: "danger", key: "licence.banner.unreachable", since: "2026-10-28T14:05:00Z" },
  );
  assert.deepEqual(licenceStanding(online({ status: "unreachable", edition: "frozen" })).banner, { tone: "danger", key: "licence.banner.unreachableNever" });
  assert.deepEqual(licenceStanding(online({ status: "clock", edition: "frozen" })).banner, { tone: "danger", key: "licence.banner.clock" });
  assert.deepEqual(licenceStanding(online({ status: "revoked" })).tag, { tone: "danger", key: "licence.tag.revoked" });
  assert.deepEqual(licenceStanding(online({ status: "not_yet", edition: "community" })).tag, { tone: "info", key: "licence.tag.notYet" });
});

test("an_offline_licence_never_offers_a_check_and_shows_its_next", () => {
  const s = licenceStanding(online({ mode: "offline", lastCheckInAt: undefined, next: { validFrom: "2026-12-31T00:00:00Z", validUntil: "2027-12-31T00:00:00Z", seats: 60 } }));
  assert.equal(s.modeKey, "licence.mode.offline");
  assert.equal(s.canCheck, false);
  assert.deepEqual(s.next, { key: "licence.next.offline", validFrom: "2026-12-31T00:00:00Z", validUntil: "2027-12-31T00:00:00Z", seats: 60 });
  assert.equal(licenceStanding(online({ next: { validFrom: "a", validUntil: "b", seats: 25 } })).next?.key, "licence.next.online");
});

test("a_first_version_or_older_server_licence_reads_as_before", () => {
  const s = licenceStanding({ licenceId: "l", organisation: "A", seats: 5, used: 1, validUntil: "2027-01-01T00:00:00Z", edition: "frozen" });
  assert.deepEqual(s.tag, { tone: "warning", key: "licence.expiredTag" });
  assert.equal(s.modeKey, null);
  assert.equal(s.canCheck, false);
  assert.equal(s.banner, null);
});

test("a_service_that_answered_without_confirming_the_licence_has_its_own_sentence", () => {
  const s = licenceStanding(online({ status: "no_status", edition: "frozen" }));
  assert.deepEqual(s.tag, { tone: "warning", key: "licence.tag.noStatus" });
  assert.deepEqual(s.banner, { tone: "danger", key: "licence.banner.noStatus" });
  assert.equal(s.canCheck, true);
});
