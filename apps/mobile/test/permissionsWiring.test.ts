import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");

test("the_space_provider_tells_a_guest_whose_access_ended_and_a_removed_member", () => {
  assert.match(src("space/SpaceProvider.tsx"), /spaceEndings/);
});

test("guest_only_groups_wear_the_guests_tag_in_the_list_the_editor_and_the_member_chips", () => {
  for (const f of ["screens/space/SpaceGroupsScreen.tsx", "screens/space/GroupEditorScreen.tsx", "screens/space/MemberScreen.tsx", "screens/space/MemberManage.tsx"]) {
    assert.match(src(f), /groupTagFor/, f);
  }
});

test("dates_are_read_in_one_zone_the_locale_hook_never_the_device_directly", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : n.endsWith(".tsx") ? [join(dir, n)] : []));
  for (const file of walk(new URL("../src/screens", import.meta.url).pathname).concat(walk(new URL("../src/ui", import.meta.url).pathname))) {
    const text = readFileSync(file, "utf8");
    if (/ProfileScreen/.test(file)) continue; // the zone picker offers the device's zone as its default
    assert.doesNotMatch(text, /deviceZone\(|DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone/, file);
  }
});

test("the_open_conversation_follows_a_role_edit", () => {
  for (const f of ["screens/discussions/ConversationScreen.tsx", "screens/discussions/ThreadScreen.tsx", "screens/discussions/ConversationDetails.tsx"]) {
    assert.match(src(f), /affects\.channelRights\(/, f);
    assert.doesNotMatch(src(f), /useReloadOn\([^\n]*affects\.channels\(e, [^\n]*channels\.reload/, f);
  }
});

test("an_unreadable_licence_shows_its_label_instead_of_a_formatted_date", () => {
  assert.match(src("screens/account/InstanceAdminScreen.tsx"), /row\.unreadable \? t\("admin\.licenceUnreadable"\)/);
});
