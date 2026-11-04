// A control is shown on a permission (`rightsOf`, `spaceGates`, `channelGates`), never on a role string:
// a custom role that moderates must see the moderation, an administrator by role who was given nothing in a
// channel must not. This fails when a file compares a role to "admin", "owner", "member" or "guest", tests one
// with `includes(role)` or `switch (role)`, or calls the legacy `canAdminister`/`canEditIdentity`/`canDeleteSpace`,
// outside the files below, each kept on purpose and counted.
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

const ROLE = '(?:admin|owner|member|guest)';
/** Every way a role string is turned into a decision. Global, so each occurrence counts. */
const PATTERNS: RegExp[] = [
  // role === "owner" / "guest" ... and the reverse order
  new RegExp(`[rR]ole\\)?\\s*[!=]==?\\s*"${ROLE}"`, "g"),
  new RegExp(`"${ROLE}"\\s*[!=]==?\\s*[\\w.?]*[rR]ole`, "g"),
  // the legacy helpers
  /\b(canAdminister|canEditIdentity|canDeleteSpace)\(/g,
  // [..."admin"...].includes(role) and X.includes(role)
  /\[[^\]\n]*"(?:admin|owner|member|guest)"[^\]\n]*\]\.includes\(/g,
  /\.includes\(\s*[\w.?!]*[rR]ole\s*\)/g,
  // switch (role) {
  /switch\s*\(\s*[\w.?]*[rR]ole\b/g,
];
const count = (text: string) => PATTERNS.reduce((n, p) => n + (text.match(p)?.length ?? 0), 0);

/**
 * The files allowed to read a role, how many times, and why. A new entry needs the same kind of reason,
 * and a new role comparison in a listed file moves its count, which fails the test: read the count
 * as "these N comparisons were looked at". The legacy fallbacks (an instance without the permissions)
 * all live in `logic/spaceRoles.ts` (`legacyDoors`, `PHONE_LEGACY_CHANNEL`); a screen asks it.
 */
const ALLOWED: Record<string, { count: number; why: string }> = {
  "logic/spaceRoles.ts": { count: 12, why: "the legacy rules themselves, the one module of fallbacks, and the rank order of roles" },
  "logic/spaceSections.ts": { count: 2, why: "the licence is the owner's alone (a rule of ownership, not a right)" },
  "logic/memberScreen.ts": { count: 3, why: "the owner alone hands the space over; a member's role read as data to filter the list" },
  "logic/groupEditor.ts": { count: 1, why: "a guest cannot be appointed into a group: the guest ceiling, read on the person as data" },
  "logic/mentionGroups.ts": { count: 1, why: "a guest cannot mention a group: the guest ceiling (the server refuses it)" },
  "compose/Composer.tsx": { count: 1, why: "a guest gets no group in the mention suggestions: the guest ceiling" },
  "screens/space/SpaceMembersScreen.tsx": { count: 5, why: "member rows: the roles a member holds, read as data (locked rows, the guest tag)" },
  "screens/space/SpaceLicenceScreen.tsx": { count: 1, why: "the licence is the owner's alone" },
  "screens/space/SpaceRolesScreen.tsx": { count: 2, why: "counts the owners, and the owner's own view of the roles" },
  "screens/space/MemberScreen.tsx": { count: 3, why: "shows the roles a member holds, read as data" },
  "screens/space/MemberManage.tsx": { count: 4, why: "ownership transfer is the owner's alone; shows the roles a member holds" },
  "screens/space/MemberLegacy.tsx": { count: 4, why: "the legacy role picker of an instance without the permissions" },
  "screens/space/GroupEditorScreen.tsx": { count: 1, why: "only an owner may appoint another owner into a group" },
  "screens/space/RoleEditorScreen.tsx": { count: 1, why: "the Guests role lists the guests: a member's role read as data" },
  "screens/access/AddTargetScreen.tsx": { count: 2, why: "a person picked for an access rule is tagged guest: a member's role read as data" },
  "screens/discussions/InviteScreen.tsx": { count: 3, why: "the role the invitation will give, not the viewer's" },
};

test("the_detection_sees_every_way_a_role_becomes_a_decision", () => {
  for (const code of [
    'if (space.role === "owner") x()',
    'if ("admin" !== role) x()',
    'canAdminister(space.role)',
    '["owner", "admin"].includes(space.role)',
    "ROLES.includes(role)",
    "switch (space.role) {",
    'if (member.role === "guest") x()',
    'viewerRole !== "guest"',
  ]) assert.ok(count(code) > 0, code);
  assert.equal(count("group.roleIds.includes(role.id)"), 0, "a role id is data, not a role string");
});

test("no_control_is_gated_on_a_role_string_outside_the_listed_exceptions", () => {
  const found = files(SRC).map((path) => [relative(SRC, path), count(readFileSync(path, "utf8"))] as const).filter(([, n]) => n > 0);
  const offenders = found.filter(([path]) => !(path in ALLOWED)).map(([path]) => path).sort();
  assert.deepEqual(offenders, [], "gate by permission: rightsOf, spaceGates, channelGates");
});

test("a_listed_file_holds_exactly_the_comparisons_that_were_looked_at", () => {
  const moved = Object.entries(ALLOWED)
    .map(([rel, { count: expected }]) => ({ rel, expected, now: count(readFileSync(join(SRC, rel), "utf8")) }))
    .filter((f) => f.expected !== f.now);
  assert.deepEqual(moved, [], "a role comparison was added to (or removed from) a listed file: gate on a permission, or update the count with its reason");
});
