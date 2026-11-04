// Run with `pnpm --filter @ruchoir/web test` (Node's own runner, types stripped by Node).
import { test } from "node:test";
import assert from "node:assert/strict";
import { endedSpaces, guestNoticeSummary, whenLabel } from "./guestNotices.ts";

const say = (which: "soon" | "ending", vars: Record<string, string>) => `${which}:${Object.values(vars).join("|")}`;

test("both_notice_kinds_render", () => {
  assert.equal(guestNoticeSummary({ kind: "guest_expiry_soon", actor: "Inès Garnier", spaceName: "Atelier Dupont", daysLeft: 7 }, "fr", say), "soon:Inès Garnier|dans 7 jours");
  assert.equal(guestNoticeSummary({ kind: "guest_access_ending", actor: "", spaceName: "Atelier Dupont", daysLeft: 1 }, "fr", say), "ending:Atelier Dupont|demain");
  // The wording of "when" follows the language.
  assert.equal(whenLabel(7, "en"), "in 7 days");
  assert.equal(whenLabel(1, "en"), "tomorrow");
  assert.equal(guestNoticeSummary({ kind: "mention", actor: "x", spaceName: "y" }, "fr", say), null);
});

test("a_vanished_space_shows_the_ended_notice_once", () => {
  const told = new Set<string>();
  const before = [{ id: "a", name: "Atelier Dupont" }, { id: "b", name: "Compta" }];
  const first = endedSpaces(before, [{ id: "b" }], told);
  assert.deepEqual(first, [{ id: "a", name: "Atelier Dupont" }]);
  // The same refetch again, or the next frame: nothing more to say.
  assert.deepEqual(endedSpaces(before, [{ id: "b" }], told), []);
  // A space that is still there is never reported.
  assert.deepEqual(endedSpaces(before, before, new Set()), []);
});

import { noticeTarget } from "./guestNotices.ts";

test("the_soon_notice_offers_prolong_for_that_guest", () => {
  assert.deepEqual(noticeTarget({ kind: "guest_expiry_soon", spaceId: "s1", actorId: "g9" }), { action: "prolong", spaceId: "s1", userId: "g9" });
  // Without the guest's id in the payload, the Members tab opens and nobody is guessed.
  assert.deepEqual(noticeTarget({ kind: "guest_expiry_soon", spaceId: "s1" }), { action: "members", spaceId: "s1" });
});

test("the_guest_notice_opens_the_space", () => {
  assert.deepEqual(noticeTarget({ kind: "guest_access_ending", spaceId: "s1" }), { action: "space", spaceId: "s1" });
  assert.equal(noticeTarget({ kind: "mention", spaceId: "s1" }), null);
});
