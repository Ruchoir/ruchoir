// Run with `pnpm --filter @ruchoir/client test` (Node's own runner, types stripped by Node).
import { test } from "node:test";
import assert from "node:assert/strict";

import { canCustomise, nextRadio, changedCount, draftOf, groupsOf, locksOf, resultOf, ruleOf, setState, stateOf } from "../src/permissionsLogic/customise.ts";

test("tristate_maps_to_allow_and_deny", () => {
  let draft = draftOf({ allow: ["message.pin"], deny: ["message.mention_all"] });
  assert.equal(stateOf(draft, "message.pin"), "allow");
  assert.equal(stateOf(draft, "message.mention_all"), "deny");
  assert.equal(stateOf(draft, "message.send"), "inherited");
  draft = setState(draft, "message.send", "deny");
  draft = setState(draft, "message.pin", "inherited");
  // The request lists permissions in the catalogue's order, never both lists for one name.
  assert.deepEqual(ruleOf("channel", draft), { allow: [], deny: ["message.send", "message.mention_all"] });
  assert.deepEqual(ruleOf("channel", {}), { allow: [], deny: [] });
  assert.equal(changedCount({ allow: ["message.pin"], deny: ["message.mention_all"] }, draft), 2);
  assert.equal(changedCount({ allow: [], deny: [] }, {}), 0);
});

test("customise_locks_what_the_editor_does_not_hold", () => {
  // A moderator holds the first two groups and two of the three management rights: exactly the
  // rows outside `held` are locked, whatever levels the editor may hand out.
  const held = ["channel.view", "message.react", "message.send", "message.attach", "message.pin", "message.mention_all", "message.manage", "channel.members.manage"];
  const locks = locksOf("channel", held, false);
  assert.deepEqual(Object.keys(locks), ["channel.manage"]);
  assert.equal(locks["channel.manage"], "not_held");
  // A guest never holds the manage rights, even when the editor does.
  const guest = locksOf("channel", [...held, "channel.manage"], true);
  assert.deepEqual(Object.keys(guest).sort(), ["channel.manage", "channel.members.manage", "message.manage"]);
  assert.equal(guest["channel.manage"], "guest");
  // Holding nothing locks everything.
  assert.equal(Object.keys(locksOf("calendar", [], false)).length, 3);
  assert.equal(Object.keys(locksOf("file", ["files.view", "files.create", "files.edit", "files.manage", "files.public_link"], false)).length, 0);
});

test("groups_follow_the_family_of_the_resource", () => {
  assert.deepEqual(groupsOf("channel").map((g) => g.group), ["read", "participate", "manage"]);
  assert.deepEqual(groupsOf("file")[1].permissions, ["files.create", "files.edit"]);
  assert.deepEqual(groupsOf("calendar").flatMap((g) => g.permissions), ["calendar.view", "calendar.write", "calendar.manage"]);
});

test("personnaliser_is_hidden_where_only_levels_are_taken", () => {
  const line = (kind: "everyone" | "role" | "group" | "audience", guest = false) => ({ target: { kind }, guest });
  const everyone = line("everyone");
  const guests = line("everyone", true);
  const group = line("group");
  assert.equal(canCustomise("channel", everyone, false), false);
  assert.equal(canCustomise("channel", guests, false), false);
  assert.equal(canCustomise("channel", line("role"), true), false);
  assert.equal(canCustomise("channel", line("role"), false), true);
  assert.equal(canCustomise("channel", group, false), true);
  assert.equal(canCustomise("calendar", everyone, false), false);
  assert.equal(canCustomise("calendar", line("role"), true), false);
  assert.equal(canCustomise("calendar", guests, false), true);
  for (const target of [everyone, guests, line("role"), group]) assert.equal(canCustomise("file", target, true), true);
  assert.equal(canCustomise("channel", line("audience"), false), false);
});

test("the_result_line_says_the_level_and_its_exceptions", () => {
  assert.deepEqual(resultOf("channel", "contribute", { "message.mention_all": "deny" }), { level: "contribute", except: ["message.mention_all"], plus: [] });
  assert.deepEqual(resultOf("channel", "read", { "message.pin": "allow", "channel.view": "deny" }), { level: "read", except: ["channel.view"], plus: ["message.pin"] });
  assert.deepEqual(resultOf("file", "none", {}), { level: "read", except: [], plus: [] });
});

test("arrow_keys_move_and_select_within_the_radio_group", () => {
  // Three options; Right and Down go forward, Left and Up back, both wrapping (WAI-ARIA radio group).
  assert.equal(nextRadio("ArrowRight", 0, 3), 1);
  assert.equal(nextRadio("ArrowDown", 1, 3), 2);
  assert.equal(nextRadio("ArrowRight", 2, 3), 0);
  assert.equal(nextRadio("ArrowLeft", 0, 3), 2);
  assert.equal(nextRadio("ArrowUp", 2, 3), 1);
  assert.equal(nextRadio("Home", 2, 3), 0);
  assert.equal(nextRadio("End", 0, 3), 2);
  // Any other key is left alone, and a disabled group moves nowhere.
  assert.equal(nextRadio("Tab", 0, 3), undefined);
  assert.equal(nextRadio("a", 0, 3), undefined);
  assert.equal(nextRadio("ArrowRight", 0, 0), undefined);
});
