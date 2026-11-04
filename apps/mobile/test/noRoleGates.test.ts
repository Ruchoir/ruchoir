// A control is shown on a permission (`rightsOf`, `spaceGates`, `channelGates`), never on a role string:
// a custom role that moderates must see the moderation, an administrator by role who was given nothing in a
// channel must not. This fails when a file compares a role to "admin", "owner" or "member", or calls the
// legacy `canAdminister`/`canEditIdentity`/`canDeleteSpace`, outside the files below, each kept on purpose.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = new URL("../src/", import.meta.url).pathname;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

const GATE = /[rR]ole\)?\s*[!=]==?\s*"(admin|owner|member)"|"(admin|owner|member)"\s*[!=]==?\s*[\w.?]*[rR]ole|\b(canAdminister|canEditIdentity|canDeleteSpace)\(/;

/** The files allowed to read a role, and why. A new entry needs the same kind of reason. */
const ALLOWED: Record<string, string> = {
  "logic/spaceRoles.ts": "the legacy rules themselves, the fallback of an instance without the permissions",
  "logic/spaceSections.ts": "legacy fallback of the settings sections, and the owner-only licence",
  "logic/memberScreen.ts": "the owner alone hands the space over (a rule of ownership, not a right)",
  "space/rights.ts": "the legacy fallback of the invite door",
  "screens/space/SpaceSheet.tsx": "legacy fallback of the sheet's two doors, `supported ? gate : role`",
  "screens/space/SpaceMembersScreen.tsx": "member rows: legacy fallback and the roles a member holds, read as data",
  "screens/space/SpaceGeneralScreen.tsx": "legacy fallback of the doors; the space's identity and deletion belong to its owner",
  "screens/space/SpaceLicenceScreen.tsx": "the licence is the owner's alone",
  "screens/space/SpaceRolesScreen.tsx": "counts the owners, and the owner's own view of the roles",
  "screens/space/MemberScreen.tsx": "shows the roles a member holds, read as data",
  "screens/space/MemberManage.tsx": "ownership transfer is the owner's alone; shows the roles a member holds",
  "screens/space/MemberLegacy.tsx": "the legacy role picker of an instance without the permissions",
  "screens/space/GroupEditorScreen.tsx": "only an owner may appoint another owner into a group",
  "screens/discussions/InviteScreen.tsx": "the role the invitation will give, not the viewer's",
  "screens/discussions/ConversationDetails.tsx": "legacy fallback of the channel rank (`gates.strict` false)",
  "screens/files/TrashList.tsx": "legacy fallback of emptying the trash (`supported` false)",
};

test("no_control_is_gated_on_a_role_string_outside_the_listed_exceptions", () => {
  const hits = files(SRC)
    .filter((path) => GATE.test(readFileSync(path, "utf8")))
    .map((path) => relative(SRC, path))
    .sort();
  const offenders = hits.filter((path) => !(path in ALLOWED));
  assert.deepEqual(offenders, [], "gate by permission: rightsOf, spaceGates, channelGates");
});

test("every_listed_exception_still_needs_to_be", () => {
  const stale = Object.keys(ALLOWED).filter((rel) => !GATE.test(readFileSync(join(SRC, rel), "utf8")));
  assert.deepEqual(stale, []);
});
