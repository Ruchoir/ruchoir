import { test } from "node:test";
import assert from "node:assert/strict";

import { buildConversations, listConversations, type ConversationItem } from "../src/logic/conversations.ts";

const item = (over: Partial<ConversationItem>): ConversationItem => ({
  id: over.id ?? "x",
  kind: "channel",
  name: "Équipe",
  unread: 0,
  ...over,
});

const ITEMS = [
  item({ id: "c1", kind: "channel", name: "Équipe", unread: 3, at: "2026-10-13T10:42:00Z" }),
  item({ id: "d1", kind: "person", name: "Léa Martin", unread: 1, at: "2026-10-13T10:15:00Z" }),
  item({ id: "c2", kind: "channel", name: "Projets clients", at: "2026-10-13T09:30:00Z" }),
  item({ id: "d2", kind: "group", name: "Hugo, Sophie", at: "2026-10-12T18:00:00Z" }),
  item({ id: "c3", kind: "channel", name: "Annonces" }),
];

const ids = (list: ConversationItem[]) => list.map((c) => c.id);

test("unread_keeps_only_unread", () => {
  assert.deepEqual(ids(listConversations(ITEMS, "unread", "")), ["c1", "d1"]);
});

test("groups_are_channels_and_group_messages_people_are_one_to_one", () => {
  assert.deepEqual(ids(listConversations(ITEMS, "groups", "")), ["c1", "c2", "d2", "c3"]);
  assert.deepEqual(ids(listConversations(ITEMS, "people", "")), ["d1"]);
});

test("query_ignores_case_and_accents", () => {
  assert.deepEqual(ids(listConversations(ITEMS, "all", "lea")), ["d1"]);
  assert.deepEqual(ids(listConversations(ITEMS, "all", "EQUI")), ["c1"]);
});

test("most_recent_first_and_silent_ones_last", () => {
  assert.deepEqual(ids(listConversations(ITEMS, "all", "")), ["c1", "d1", "c2", "d2", "c3"]);
});

test("a_channel_previews_its_latest_message_and_a_dm_its_own", () => {
  const built = buildConversations(
    [
      { id: "c1", name: "Équipe", unread: 2, member: true } as never,
      { id: "c9", name: "Not mine", unread: 0, member: false } as never,
    ],
    [{ id: "d1", name: "Léa Martin", unread: 0, userId: "u2", presence: "online", lastMessage: { excerpt: "À demain", mine: true, at: "2026-10-13T08:00:00Z" } } as never],
    { c1: { author: "Léa Martin", body: "**Le planning** est en ligne", createdAt: "2026-10-13T10:00:00Z" } as never },
  );
  assert.deepEqual(ids(built), ["c1", "d1"]);
  assert.deepEqual(built[0].preview, { author: "Léa Martin", text: "Le planning est en ligne", mine: false });
  assert.equal(built[0].at, "2026-10-13T10:00:00Z");
  assert.deepEqual(built[1].preview, { text: "À demain", mine: true });
  assert.equal(built[1].kind, "person");
});

test("a_system_message_or_an_empty_body_gives_no_preview", () => {
  const [built] = buildConversations(
    [{ id: "c1", name: "général", unread: 0, member: true } as never],
    [],
    { c1: { author: "", body: "", kind: "system", createdAt: "2026-10-03T08:57:38Z" } as never },
  );
  assert.equal(built.preview, undefined);
  assert.equal(built.at, "2026-10-03T08:57:38Z");
});
