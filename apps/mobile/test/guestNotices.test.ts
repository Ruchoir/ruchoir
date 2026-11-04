import { test } from "node:test";
import assert from "node:assert/strict";

import { guestBannerFor, noticeData, prolongStep } from "../src/logic/guestNotices.ts";
import { tapTarget } from "../src/push/tap.ts";

const ZONE = "Europe/Paris";
const NOW = new Date("2026-11-04T10:00:00Z");

test("a_manager_notice_opens_the_guest_on_prolong_and_without_an_id_the_members", () => {
  const withId = noticeData({ kind: "guest_expiry_soon", spaceId: "s1", actorId: "g1" });
  assert.deepEqual(tapTarget(withId), { spaceId: "s1", screen: "member", userId: "g1" });
  const bare = noticeData({ kind: "guest_expiry_soon", spaceId: "s1" });
  assert.deepEqual(tapTarget(bare), { spaceId: "s1", screen: "members" });
});

test("the_guests_own_notice_opens_the_space", () => {
  assert.deepEqual(tapTarget(noticeData({ kind: "guest_access_ending", spaceId: "s2" })), { spaceId: "s2", screen: "space" });
});

test("other_kinds_carry_no_notice_data_and_a_notice_without_a_space_still_resolves", () => {
  assert.equal(noticeData({ kind: "mention", spaceId: "s1" }), null);
  assert.deepEqual(tapTarget({ kind: "guest_access_ending" }), { spaceId: undefined, screen: "space" });
});

test("the_banner_is_for_a_guest_whose_access_has_an_end", () => {
  assert.equal(guestBannerFor({ role: "member", expiresAt: "2026-11-07T22:59:59Z" }, NOW, ZONE), null);
  assert.equal(guestBannerFor({ role: "guest" }, NOW, ZONE), null);
  assert.equal(guestBannerFor(null, NOW, ZONE), null);
});

test("the_banner_turns_soon_and_adds_its_card_within_seven_days", () => {
  const far = guestBannerFor({ role: "guest", expiresAt: "2026-12-04T22:59:59Z" }, NOW, ZONE);
  assert.deepEqual([far?.days, far?.tone, far?.card], [30, "calm", false]);
  const edge = guestBannerFor({ role: "guest", expiresAt: "2026-11-11T22:59:59Z" }, NOW, ZONE);
  assert.deepEqual([edge?.days, edge?.tone, edge?.card], [7, "soon", true]);
  const near = guestBannerFor({ role: "guest", expiresAt: "2026-11-07T22:59:59Z" }, NOW, ZONE);
  assert.deepEqual([near?.days, near?.tone, near?.card, near?.until], [3, "soon", true, "2026-11-07T22:59:59Z"]);
});

test("a_waiting_prolong_link_waits_for_the_list_opens_a_known_space_and_is_dropped_for_an_unknown_one", () => {
  const spaces = [{ id: "s1", slug: "atelier" }];
  assert.deepEqual(prolongStep(undefined, "atelier"), { kind: "wait" });
  assert.deepEqual(prolongStep(spaces, "atelier"), { kind: "open", space: spaces[0] });
  assert.deepEqual(prolongStep(spaces, "other"), { kind: "drop" });
});

test("a_space_that_left_the_list_is_told_once_to_a_guest_and_to_a_removed_member_after_a_rights_event", async () => {
  const { spaceEndings } = await import("../src/logic/guestNotices.ts");
  const told = new Set<string>();
  const before = [
    { id: "a", name: "Atelier", role: "guest" },
    { id: "b", name: "Studio", role: "member" },
    { id: "c", name: "Reste", role: "member" },
  ];
  const after = [{ id: "c" }];
  const ctx = { caused: new Set(["a", "b"]), muted: new Set<string>() };
  assert.deepEqual(spaceEndings(before, after, told, ctx), [
    { space: "Atelier", title: "guests.endedNotice", body: "guests.endedNoticeBody" },
    { space: "Studio", title: "guests.leftNotice" },
  ]);
  assert.deepEqual(spaceEndings(before, after, told, ctx), []);
});

test("a_space_gone_without_a_rights_event_is_not_told", async () => {
  const { spaceEndings } = await import("../src/logic/guestNotices.ts");
  const before = [{ id: "a", name: "Atelier", role: "owner" }, { id: "c", name: "Reste", role: "member" }];
  // Deleted by its owner, signed out, an instance switch, an empty list: nothing caused a notice.
  assert.deepEqual(spaceEndings(before, [{ id: "c" }], new Set(), { caused: new Set(), muted: new Set() }), []);
  assert.deepEqual(spaceEndings(before, [], new Set(), { caused: new Set(), muted: new Set() }), []);
});

test("a_space_this_phone_deleted_or_left_is_never_told_even_after_a_rights_event", async () => {
  const { spaceEndings } = await import("../src/logic/guestNotices.ts");
  const before = [{ id: "a", name: "Atelier", role: "owner" }];
  const out = spaceEndings(before, [], new Set(), { caused: new Set(["a"]), muted: new Set(["a"]) });
  assert.deepEqual(out, []);
});

test("an_event_is_a_cause_only_for_a_rights_change_or_a_removal", async () => {
  const { endingCause } = await import("../src/logic/guestNotices.ts");
  assert.equal(endingCause({ type: "permissions", spaceId: "s1" }), "s1");
  assert.equal(endingCause({ type: "spaces", removed: { spaceId: "s2", reason: "removed" } }), "s2");
  assert.equal(endingCause({ type: "spaces", removed: { spaceId: "s2", reason: "deleted" } }), null);
  assert.equal(endingCause({ type: "spaces", removed: { spaceId: "s2", reason: "left" } }), null);
  assert.equal(endingCause({ type: "spaces" }), null);
  assert.equal(endingCause({ type: "files", spaceId: "s1" }), null);
});
