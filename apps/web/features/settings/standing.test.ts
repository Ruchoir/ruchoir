// Run with `pnpm --filter @ruchoir/web test` (Node's own runner, types stripped by Node).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gestionControls, seatsAfterInvite, standingGain, standingLoss } from "./guestLogic.ts";
import { passerMembre } from "./guestActions.ts";

type Dict = Record<string, unknown>;
function say(locale: string, line: { key: string; names?: string[] }): string {
  const dict = JSON.parse(readFileSync(new URL(`../../lib/i18n/dictionaries/${locale}.json`, import.meta.url), "utf8")) as Dict;
  const text = line.key.split(".").reduce<unknown>((at, part) => (at as Dict | undefined)?.[part], dict) as string;
  return text.replace("{{roles}}", new Intl.ListFormat(locale, { type: "conjunction" }).format(line.names ?? []));
}

const roles = [
  { id: "r1", name: "Comptable", systemKey: undefined },
  { id: "r2", name: "Communication", systemKey: undefined },
  { id: "rm", name: "members", systemKey: "members" as const },
];
const person = (over: Record<string, unknown> = {}) => ({ userId: "u1", name: "Paul Girard", role: "member", bot: false, ...over });

test("passer_invite_lists_loss_and_keep", () => {
  const { loses, keeps } = standingLoss(person(), roles);
  assert.deepEqual(loses.map((l) => l.key), ["guests.loseView", "guests.loseDirectory", "guests.loseCeiling"]);
  assert.deepEqual(keeps.map((l) => l.key), ["guests.keepChannels", "guests.keepMessages", "guests.keepGroups"]);
  // The seats line: one fewer used.
  assert.deepEqual(seatsAfterInvite({ seats: 8, used: 8 }), { used: 7, total: 8 });
  assert.equal(seatsAfterInvite(undefined), null);
});

test("passer_invite_mentions_kept_roles", () => {
  const { keeps } = standingLoss(person({ roleIds: ["r1", "r2", "rm"] }), roles);
  const kept = keeps.find((l) => l.key === "guests.keepRoles");
  assert.deepEqual(kept?.names, ["Comptable", "Communication"]);
  assert.match(say("fr", kept!), /Comptable et Communication/);
});

test("passer_membre_on_402_opens_the_seats_dialog", async () => {
  const full = Object.assign(new Error("full"), { status: 402, body: { error: "seats_full", seats: 8, pricing_url: "https://example.test/tarifs" } });
  let refreshed = 0;
  const outcome = await passerMembre({ setMemberRole: async () => { throw full; } }, { spaceId: "s", userId: "u" }, async () => void (refreshed += 1));
  assert.deepEqual(outcome, { ok: false, seatsFull: { seats: 8, pricingUrl: "https://example.test/tarifs" } });
  assert.equal(refreshed, 0);
  const done = await passerMembre({ setMemberRole: async () => [] }, { spaceId: "s", userId: "u" }, async () => void (refreshed += 1));
  assert.deepEqual(done, { ok: true });
  assert.equal(refreshed, 1);
  // Any other failure is not a seats refusal: it is thrown.
  await assert.rejects(passerMembre({ setMemberRole: async () => { throw new Error("boom"); } }, { spaceId: "s", userId: "u" }, async () => {}));
});

test("passer_membre_says_the_date_is_cleared", () => {
  assert.ok(standingGain(person({ role: "guest", expiresAt: "2026-12-12T22:59:59Z" })).some((l) => l.key === "guests.gainClearsDate"));
  assert.ok(!standingGain(person({ role: "guest" })).some((l) => l.key === "guests.gainClearsDate"));
  assert.ok(standingGain(person({ role: "guest" })).some((l) => l.key === "guests.gainSeat"));
});

test("gestion_of_a_guest_shows_the_end_control", () => {
  const c = gestionControls(person({ role: "guest", manageable: true }), ["members.manage"]);
  assert.equal(c.endControl, true);
  assert.equal(c.toMember, true);
  assert.equal(c.toGuest, false);
  assert.equal(gestionControls(person({ role: "guest", manageable: true }), ["roles.manage"]).endControl, false);
});

test("a_member_has_no_end_control", () => {
  const c = gestionControls(person({ role: "member", manageable: true }), ["members.manage"]);
  assert.equal(c.endControl, false);
  assert.equal(c.toMember, false);
  assert.equal(c.toGuest, true);
  // Nobody turns an owner or an administrator into a guest from here.
  assert.equal(gestionControls(person({ role: "owner", manageable: true }), ["members.manage"]).toGuest, false);
});
