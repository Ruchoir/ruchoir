// Run with `pnpm --filter @ruchoir/web test` (Node's own runner, types stripped by Node).
import { test } from "node:test";
import assert from "node:assert/strict";
import { canSeeEnded, guestMenu, guestRow, splitPeople } from "./guestLogic.ts";
import { askRemoval, confirmRemoval, reactivateGuestAccess, saveGuestExpiry } from "./guestActions.ts";

const PARIS = "Europe/Paris";
const NOW = new Date("2026-11-15T09:00:00Z");
const person = (userId: string, role: string, over: Record<string, unknown> = {}) => ({ userId, name: userId, role, bot: false, ...over });

test("guests_leave_the_main_table_and_fill_their_section", () => {
  const people = [person("a", "owner"), person("b", "admin"), person("c", "member"), person("d", "guest"), person("e", "guest"), person("bot", "member", { bot: true })];
  const { members, guests } = splitPeople(people);
  assert.deepEqual(members.map((m) => m.userId), ["a", "b", "c", "bot"]);
  assert.deepEqual(guests.map((m) => m.userId), ["d", "e"]);
});

test("a_soon_guest_gets_the_warning_and_prolong", () => {
  const row = guestRow(person("d", "guest", { expiresAt: "2026-11-20T22:59:59Z" }), NOW, PARIS);
  assert.equal(row.days, 5);
  assert.equal(row.tone, "soon");
  assert.equal(row.warn, true);
  assert.equal(row.prolong, true);
  const far = guestRow(person("e", "guest", { expiresAt: "2026-12-12T22:59:59Z" }), NOW, PARIS);
  assert.equal(far.tone, "calm");
  assert.equal(far.warn, false);
  assert.equal(far.prolong, false);
});

test("no_date_shows_no_end_and_no_prolong_warning", () => {
  const row = guestRow(person("d", "guest"), NOW, PARIS);
  assert.equal(row.end, null);
  assert.equal(row.days, null);
  assert.equal(row.warn, false);
  assert.equal(row.prolong, false);
});

test("prolong_sends_the_new_instant_and_refreshes", async () => {
  const calls: unknown[][] = [];
  let refreshed = 0;
  const api = { setGuestExpiry: async (...args: unknown[]) => void calls.push(args) };
  await saveGuestExpiry(api, { spaceId: "s1", userId: "u1", choice: "month", now: NOW, zone: PARIS, base: "2026-11-20T22:59:59Z" }, async () => void (refreshed += 1));
  assert.deepEqual(calls, [["s1", "u1", "2026-12-20T22:59:59.000Z"]]);
  assert.equal(refreshed, 1);
  // "No end" is sent as null.
  await saveGuestExpiry(api, { spaceId: "s1", userId: "u1", choice: "none", now: NOW, zone: PARIS }, async () => void (refreshed += 1));
  assert.deepEqual(calls[1], ["s1", "u1", null]);
  // A refused call refreshes nothing and says so.
  const failing = { setGuestExpiry: async () => { throw new Error("boom"); } };
  await assert.rejects(saveGuestExpiry(failing, { spaceId: "s1", userId: "u1", choice: "week", now: NOW, zone: PARIS }, async () => void (refreshed += 1)));
  assert.equal(refreshed, 2);
  // An unfinished hand-picked day is not sent at all.
  await assert.rejects(saveGuestExpiry(api, { spaceId: "s1", userId: "u1", choice: { date: "" }, now: NOW, zone: PARIS }, async () => {}));
  assert.equal(calls.length, 2);
});

test("ended_access_is_hidden_without_members_manage", () => {
  assert.equal(canSeeEnded(["members.manage", "roles.manage"]), true);
  assert.equal(canSeeEnded(["roles.manage"]), false);
  assert.equal(canSeeEnded([]), false);
});

test("reactivate_sends_the_chosen_date", async () => {
  const calls: unknown[][] = [];
  let refreshed = 0;
  const api = { reactivateGuest: async (...args: unknown[]) => void calls.push(args) };
  await reactivateGuestAccess(api, { spaceId: "s1", userId: "u1", choice: { date: "2027-07-01" }, now: NOW, zone: PARIS }, async () => void (refreshed += 1));
  assert.deepEqual(calls, [["s1", "u1", "2027-07-01T21:59:59.000Z"]]);
  assert.equal(refreshed, 1);
  await reactivateGuestAccess(api, { spaceId: "s1", userId: "u1", choice: "none", now: NOW, zone: PARIS }, async () => {});
  assert.deepEqual(calls[1], ["s1", "u1", null]);
});

test("remove_for_good_asks_for_confirmation", async () => {
  const removed: unknown[][] = [];
  let refreshed = 0;
  const api = { removeMember: async (...args: unknown[]) => void removed.push(args) };
  // Nothing was asked: confirming does nothing.
  assert.equal(await confirmRemoval(api, "s1", null, async () => void (refreshed += 1)), false);
  assert.deepEqual(removed, []);
  // Asking only opens the confirmation, it removes nothing.
  const pending = askRemoval({ userId: "u1", name: "Thomas Roux" });
  assert.deepEqual(removed, []);
  assert.equal(await confirmRemoval(api, "s1", pending, async () => void (refreshed += 1)), true);
  assert.deepEqual(removed, [["s1", "u1"]]);
  assert.equal(refreshed, 1);
});

test("the_row_menu_opens_the_passer_membre_dialog", () => {
  const licensed = guestMenu({ licensed: true, canDate: true, hasEnd: true, canAct: true });
  assert.deepEqual(licensed.map((i) => i.id), ["manage", "changeDate", "passerMembre", "remove"]);
  // Passing a guest to member is a dialog (the recap, and the seats answer), never a direct change.
  assert.equal(licensed.find((i) => i.id === "passerMembre")?.opens, "dialog");
  assert.ok(!licensed.some((i) => (i.id as string) === "changeRole"));
  // No end yet: the date item offers to set one.
  assert.equal(guestMenu({ licensed: true, canDate: true, hasEnd: false, canAct: true })[1].id, "setDate");
  // A community space keeps its role select in the management panel: no shortcut here.
  assert.ok(!guestMenu({ licensed: false, canDate: true, hasEnd: true, canAct: true }).some((i) => i.id === "passerMembre"));
  assert.deepEqual(guestMenu({ licensed: true, canDate: false, hasEnd: true, canAct: false }), []);
});
