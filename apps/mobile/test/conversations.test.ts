import { test } from "node:test";
import assert from "node:assert/strict";

import { buildConversations, listConversations, withLivePresence, type ConversationItem } from "../src/logic/conversations.ts";

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

test("groups_are_channels_and_people_are_private_conversations", () => {
  // A private conversation with several people is still a conversation with people, not a room.
  assert.deepEqual(ids(listConversations(ITEMS, "groups", "")), ["c1", "c2", "c3"]);
  assert.deepEqual(ids(listConversations(ITEMS, "people", "")), ["d1", "d2"]);
});

test("query_ignores_case_and_accents", () => {
  assert.deepEqual(ids(listConversations(ITEMS, "all", "lea")), ["d1"]);
  assert.deepEqual(ids(listConversations(ITEMS, "all", "EQUI")), ["c1"]);
});

test("most_recent_first_and_silent_ones_last", () => {
  assert.deepEqual(ids(listConversations(ITEMS, "all", "")), ["c1", "d1", "c2", "d2", "c3"]);
});

test("channels_and_conversations_carry_their_own_preview", () => {
  const built = buildConversations(
    [
      {
        id: "c1",
        name: "Équipe",
        unread: 2,
        member: true,
        memberCount: 8,
        lastMessage: { excerpt: "**Le planning** est en ligne", mine: false, at: "2026-10-13T10:00:00Z", author: "Léa Martin" },
      } as never,
      { id: "c9", name: "Not mine", unread: 0, member: false } as never,
    ],
    [{ id: "d1", name: "Léa Martin", unread: 0, userId: "u2", presence: "online", lastMessage: { excerpt: "À demain", mine: true, at: "2026-10-13T08:00:00Z" } } as never],
  );
  assert.deepEqual(ids(built), ["c1", "d1"]);
  assert.deepEqual(built[0].preview, { author: "Léa Martin", text: "Le planning est en ligne", mine: false });
  assert.equal(built[0].at, "2026-10-13T10:00:00Z");
  assert.equal(built[0].members, 8);
  assert.deepEqual(built[1].preview, { text: "À demain", mine: true });
  assert.equal(built[1].kind, "person");
});

test("a_channel_where_nobody_wrote_previews_what_happened_last", () => {
  const [built] = buildConversations(
    [
      {
        id: "c1",
        name: "général",
        unread: 0,
        member: true,
        lastMessage: { excerpt: "Repro salon", mine: false, at: "2026-10-03T08:57:38Z", author: "Alice", notice: true, systemEvent: "calendar_event_posted" },
      } as never,
    ],
    [],
  );
  assert.deepEqual(built.preview, { text: "Repro salon", mine: false, notice: { event: "calendar_event_posted", who: "Alice" } });
  assert.equal(built.at, "2026-10-03T08:57:38Z");
});

test("a_message_with_only_files_says_so_and_an_empty_history_gives_no_preview", () => {
  const [files, empty] = buildConversations(
    [
      { id: "c1", name: "a", unread: 0, member: true, lastMessage: { excerpt: "", mine: true, at: "2026-10-03T08:00:00Z", author: "Théo" } } as never,
      { id: "c2", name: "b", unread: 0, member: true } as never,
    ],
    [],
  );
  assert.deepEqual(files.preview, { author: "Théo", text: "", mine: true, files: true });
  assert.equal(empty.preview, undefined);
  assert.equal(empty.at, undefined);
});

test("a_channel_on_invitation_and_a_private_group_conversation_say_so", () => {
  const built = buildConversations(
    [
      { id: "c1", name: "Équipe", unread: 0, member: true, type: "public", memberCount: 8 } as never,
      { id: "c2", name: "Direction", unread: 0, member: true, type: "private", memberCount: 3 } as never,
    ],
    [{ id: "d2", name: "Hugo, Sophie", unread: 0, participantIds: ["u3", "u4"], presence: "offline" } as never],
  );
  assert.equal(built[0].private, undefined);
  assert.equal(built[1].private, true);
  assert.equal(built[2].kind, "group");
  assert.deepEqual(built[2].participants, ["u3", "u4"]);
  // The others and the reader.
  assert.equal(built[2].members, 3);
});

test("presence_moves_live_on_a_persons_row", () => {
  const items = [
    { id: "d1", kind: "person", name: "Bob", userId: "u2", presence: "offline" },
    { id: "c1", kind: "channel", name: "general" },
  ] as never as Parameters<typeof withLivePresence>[0];
  const shown = withLivePresence(items, { u2: "online" });
  assert.equal(shown[0].presence, "online");
  // Nothing heard: the rows are the ones loaded, untouched.
  assert.equal(withLivePresence(items, {}), items);
});
