import { test } from "node:test";
import assert from "node:assert/strict";

import { pickNowCards } from "../src/logic/today.ts";

const NOW = new Date("2026-10-13T10:00:00Z"); // 12:00 in Paris
const base = { now: NOW, spaceId: "s1", timeZone: "Europe/Paris", notifications: [], occurrences: [], recentFiles: [] };
const mention = (over = {}) => ({ id: "n1", kind: "mention", spaceId: "s1", read: false, createdAt: "2026-10-13T08:42:00Z", ...over }) as never;
const event = (id: string, start: string, end: string, allDay = false) => ({ eventId: id, start, end, allDay }) as never;
const file = (id: string, updatedAt: string, kind = "file") => ({ id, name: `${id}.pdf`, kind, updatedAt }) as never;

test("nothing_gives_no_card", () => {
  assert.deepEqual(pickNowCards(base), []);
});

test("the_unread_mention_comes_first", () => {
  const cards = pickNowCards({
    ...base,
    notifications: [mention({ id: "old", createdAt: "2026-10-12T08:00:00Z" }), mention({ id: "new" })],
    occurrences: [event("e1", "2026-10-13T12:00:00Z", "2026-10-13T13:00:00Z")],
  });
  assert.equal(cards[0].kind, "mention");
  assert.equal(cards[0].kind === "mention" && cards[0].notification.id, "new");
  assert.equal(cards[1].kind, "event");
});

test("a_read_or_elsewhere_mention_is_not_shown", () => {
  const cards = pickNowCards({ ...base, notifications: [mention({ read: true }), mention({ id: "n2", spaceId: "s2" }), mention({ id: "n3", kind: "calendar_reminder" })] });
  assert.deepEqual(cards, []);
});

test("a_past_event_is_not_next_and_tomorrow_is_not_today", () => {
  const cards = pickNowCards({
    ...base,
    occurrences: [
      event("past", "2026-10-13T06:00:00Z", "2026-10-13T07:00:00Z"),
      event("tomorrow", "2026-10-14T08:00:00Z", "2026-10-14T09:00:00Z"),
      event("allday", "2026-10-13", "2026-10-14", true),
      event("later", "2026-10-13T14:00:00Z", "2026-10-13T15:00:00Z"),
      event("soon", "2026-10-13T11:00:00Z", "2026-10-13T12:00:00Z"),
    ],
  });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].kind === "event" && cards[0].occurrence.eventId, "soon");
});

test("an_ongoing_event_is_next", () => {
  const [card] = pickNowCards({ ...base, occurrences: [event("now", "2026-10-13T09:30:00Z", "2026-10-13T10:30:00Z")] });
  assert.equal(card.kind === "event" && card.occurrence.eventId, "now");
});

test("an_old_file_or_a_folder_is_not_new", () => {
  const cards = pickNowCards({
    ...base,
    recentFiles: [file("folder", "2026-10-13T09:00:00Z", "folder"), file("old", "2026-10-10T09:00:00Z"), file("fresh", "2026-10-12T15:00:00Z")],
  });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].kind === "file" && cards[0].file.id, "fresh");
});
