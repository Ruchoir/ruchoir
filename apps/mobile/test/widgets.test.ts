import { test } from "node:test";
import assert from "node:assert/strict";

import { startsIn, unreadTotal, upcoming } from "../src/widgets/data.ts";

const now = new Date("2026-10-15T08:00:00Z");
const at = (iso: string, title: string, end = "2026-10-15T23:00:00Z") => ({ title, all_day: false, start: iso, end });

test("the_next_events_are_those_not_over_yet_soonest_first", () => {
  const events = upcoming(
    [at("2026-10-15T14:00:00Z", "Later"), { title: "Over", all_day: false, start: "2026-10-15T06:00:00Z", end: "2026-10-15T07:00:00Z" }, at("2026-10-15T09:00:00Z", "Soon")],
    now,
    5,
  );
  assert.deepEqual(events.map((e) => e.title), ["Soon", "Later"]);
  assert.equal(upcoming([at("2026-10-15T09:00:00Z", "A"), at("2026-10-15T10:00:00Z", "B")], now, 1).length, 1);
});

test("an_event_says_when_it_starts", () => {
  assert.deepEqual(startsIn(new Date("2026-10-15T07:30:00Z"), now), { kind: "now" });
  assert.deepEqual(startsIn(new Date("2026-10-15T08:20:00Z"), now), { kind: "minutes", n: 20 });
  assert.deepEqual(startsIn(new Date("2026-10-15T10:05:00Z"), now), { kind: "hours", n: 2 });
  assert.deepEqual(startsIn(new Date("2026-10-17T10:00:00Z"), now), { kind: "later" });
});

test("the_unread_messages_of_every_space_add_up", () => {
  assert.equal(unreadTotal([{ unread: 3 }, { unread: 0 }, {}, { unread: 4 }]), 7);
  assert.equal(unreadTotal([]), 0);
});
