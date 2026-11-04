import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { groupColour, ROLE_COLOURS, ROLE_NAME_MAX } from "../src/permissionsLogic/index.ts";

const rust = readFileSync(new URL("../../../apps/api/src/permissions/roles.rs", import.meta.url), "utf8");

test("the_role_name_limit_is_the_servers", () => {
  const server = /length == 0 \|\| length > (\d+)/.exec(rust);
  assert.ok(server, "the name limit was not found in roles.rs");
  assert.equal(ROLE_NAME_MAX, Number(server[1]));
});

test("the_role_colours_are_the_servers_in_the_same_order", () => {
  const server = /pub const ROLE_COLOURS: \[&str; \d+\] = \[([^\]]+)\]/.exec(rust);
  assert.ok(server, "ROLE_COLOURS not found in roles.rs");
  assert.deepEqual([...ROLE_COLOURS], [...server[1].matchAll(/"(\w+)"/g)].map((m) => m[1]));
});

test("a_group_wears_always_the_same_colour_from_the_list", () => {
  assert.equal(groupColour("g1"), groupColour("g1"));
  assert.ok((ROLE_COLOURS as readonly string[]).includes(groupColour("0b1c-xyz")));
});

test("the_screens_use_the_shared_constants_not_their_own", () => {
  const read = (f: string) => readFileSync(new URL(`../../../${f}`, import.meta.url), "utf8");
  for (const f of ["apps/web/features/settings/RoleEditor.tsx", "apps/web/features/settings/RolesSettings.tsx", "apps/mobile/src/screens/space/RoleName.tsx", "apps/mobile/src/screens/space/RoleCreateScreen.tsx"]) {
    assert.match(read(f), /ROLE_NAME_MAX/, f);
  }
  for (const f of ["apps/web/features/groups/GroupIcon.tsx", "apps/mobile/src/logic/groupEditor.ts"]) {
    assert.doesNotMatch(read(f), /hash \* 31/, `${f} has its own colour hash`);
  }
  assert.doesNotMatch(read("apps/web/features/settings/RoleEditor.tsx"), /export const ROLE_COLOURS/);
  assert.doesNotMatch(read("apps/mobile/src/logic/roleEditor.ts"), /COLOUR_CHOICES = \[/);
});
