import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { GROUP_DESCRIPTION_MAX } from "../src/permissionsLogic/index.ts";

test("the_group_description_limit_is_the_servers", () => {
  const rust = readFileSync(new URL("../../../apps/api/src/permissions/group_routes.rs", import.meta.url), "utf8");
  const server = /const DESCRIPTION_MAX: usize = (\d+);/.exec(rust);
  assert.ok(server, "DESCRIPTION_MAX not found in group_routes.rs");
  assert.equal(GROUP_DESCRIPTION_MAX, Number(server[1]));
});

test("the_screens_use_the_shared_limit_not_a_number_of_their_own", () => {
  for (const file of [
    "../../../apps/web/features/settings/GroupsSettings.tsx",
    "../../../apps/web/features/settings/GroupEditor.tsx",
    "../../../apps/mobile/src/screens/space/GroupFormScreen.tsx",
  ]) {
    const text = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(text, /GROUP_DESCRIPTION_MAX/, file);
    assert.doesNotMatch(text, /(maxLength=\{|DESCRIPTION_MAX = )300/, file);
  }
});
