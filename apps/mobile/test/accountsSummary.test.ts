import { test } from "node:test";
import assert from "node:assert/strict";

import { groupSpaces, unreadEverywhere } from "../src/accounts/summary.ts";

const space = (id: string) => ({ id, name: id, slug: id, role: "member", members: 1, unread: 0, mentions: 0 }) as never;

test("every_instance_is_a_section_in_the_registry_order", () => {
  const sections = groupSpaces(
    [
      { id: "a", origin: "https://a.test", status: { kind: "signedIn" } },
      { id: "b", origin: "https://b.test", status: { kind: "signedOut" } },
      { id: "c", origin: "https://c.test", status: { kind: "signedIn" } },
    ],
    { a: { spaces: [space("s1")] }, b: { spaces: [space("old")] } },
  );
  assert.deepEqual(
    sections.map((s) => [s.id, s.state, s.spaces?.map((w) => w.id) ?? null]),
    [
      ["a", "signedIn", ["s1"]],
      // A signed-out instance shows none of what it published before.
      ["b", "signedOut", null],
      // Not published yet: loading.
      ["c", "signedIn", null],
    ],
  );
});

test("the_bell_counts_every_signed_in_instance", () => {
  assert.equal(unreadEverywhere({ a: { unreadNotifications: 2 }, b: { unreadNotifications: 5 } }, ["a", "b", "c"]), 7);
  assert.equal(unreadEverywhere({ a: { unreadNotifications: 2 }, b: { unreadNotifications: 5 } }, ["a"]), 2);
});
