import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { locksQuiet, groupSteps, labelOf, alreadyVia, cardOf, reasonKey, roleSentence, STEP_KINDS, stepSentence, type StepLike } from "./whyLogic.ts";

const step = (over: Partial<StepLike> = {}): StepLike => ({ n: 1, kind: "base", permission: "files.view", effect: "granted", ...over });

test("a_role_via_a_group_names_the_group", () => {
  const direct = roleSentence({ id: "c6f204bc-8cc0-55a4-b2e2-799dcda9120e", name: "Comptable", direct: true, viaGroups: [] });
  assert.deepEqual(direct, { key: "why.role.direct", values: { role: "Comptable" } });
  const via = roleSentence({ id: "c6f204bc-8cc0-55a4-b2e2-799dcda9120e", name: "Comptable", direct: false, viaGroups: [{ id: "5942db65-eba7-5ead-870b-a5161dae5802", name: "Comptabilité" }] });
  assert.deepEqual(via, { key: "why.role.viaGroup", values: { role: "Comptable", groups: "Comptabilité" } });
  const two = roleSentence({ id: "c6f204bc-8cc0-55a4-b2e2-799dcda9120e", name: "Comptable", direct: false, viaGroups: [{ id: "5942db65-eba7-5ead-870b-a5161dae5802", name: "A" }, { id: "5a0f813b-6575-529f-9c0d-d890fdb2719c", name: "B" }] });
  assert.equal(two.values.groups, "A, B");
  const both = roleSentence({ id: "c6f204bc-8cc0-55a4-b2e2-799dcda9120e", name: "Comptable", direct: true, viaGroups: [{ id: "5942db65-eba7-5ead-870b-a5161dae5802", name: "A" }] });
  assert.equal(both.key, "why.role.directAndGroup");
  assert.equal(stepSentence(step({ kind: "role", role: { id: "c6f204bc-8cc0-55a4-b2e2-799dcda9120e", name: "Comptable", direct: false, viaGroups: [{ id: "5942db65-eba7-5ead-870b-a5161dae5802", name: "A" }] } })).values.groups, "A");
});

test("every_step_kind_has_a_sentence", () => {
  assert.equal(STEP_KINDS.length, 13);
  for (const locale of ["fr", "en", "de", "es", "it", "pl"]) {
    const dict = JSON.parse(readFileSync(new URL(`../../lib/i18n/dictionaries/${locale}.json`, import.meta.url), "utf8")) as Record<string, unknown>;
    const has = (key: string) => key.split(".").reduce<unknown>((at, part) => (at as Record<string, unknown> | undefined)?.[part], dict) !== undefined;
    for (const kind of STEP_KINDS) {
      for (const effect of ["granted", "removed"] as const) {
        const { key } = stepSentence(step({ kind, effect, level: { kind: "file", id: "4c440343-9480-50e5-b217-ff831ed67e79", name: "Compta", hidden: false }, target: { kind: "group", id: "5942db65-eba7-5ead-870b-a5161dae5802", name: "Comptabilité", hidden: false } }));
        assert.ok(has(key), `${locale}: ${key}`);
      }
    }
    for (const kind of [...STEP_KINDS, "from_the_future"]) assert.ok(has(reasonKey(kind)), `${locale}: ${reasonKey(kind)}`);
    assert.ok(has("why.reason.none"));
    for (const key of ["why.role.direct", "why.role.viaGroup", "why.role.directAndGroup"]) assert.ok(has(key), `${locale}: ${key}`);
  }
});

test("an_unknown_step_kind_still_reads_as_a_sentence", () => {
  assert.equal(stepSentence(step({ kind: "from_the_future" })).key, "why.step.unknown");
});

test("a_rule_step_names_its_target_and_where_it_sits", () => {
  const s = stepSentence(step({ kind: "rule", level: { kind: "file", id: "4c440343-9480-50e5-b217-ff831ed67e79", name: "Compta", hidden: false }, target: { kind: "group", id: "5942db65-eba7-5ead-870b-a5161dae5802", name: "Comptabilité", hidden: false } }));
  assert.equal(s.key, "why.step.rule.granted");
  assert.equal(s.values.target, "Comptabilité");
  assert.equal(s.values.where, "Compta");
  const hidden = stepSentence(step({ kind: "rule", level: { kind: "file", hidden: true }, target: { kind: "audience", hidden: true } }));
  assert.equal(hidden.key, "why.step.rule.granted");
  assert.equal(hidden.values.where, "");
  assert.equal(hidden.values.target, "");
});

test("the_result_cards_match_the_decision", () => {
  const steps = [step({ n: 1, kind: "base" }), step({ n: 4, kind: "role", permission: "files.edit", role: { id: "c6f204bc-8cc0-55a4-b2e2-799dcda9120e", name: "Comptable", direct: false, viaGroups: [{ id: "5942db65-eba7-5ead-870b-a5161dae5802", name: "Comptabilité" }] } })];
  const granted = cardOf({ permission: "files.edit", granted: true, reasonStep: 4 }, steps);
  assert.deepEqual(granted, { permission: "files.edit", granted: true, reason: { n: 4, kind: "role" } });
  const refused = cardOf({ permission: "files.manage", granted: false }, steps);
  assert.deepEqual(refused, { permission: "files.manage", granted: false, reason: undefined });
  const removed = cardOf({ permission: "files.view", granted: false, reasonStep: 9 }, steps);
  assert.equal(removed.reason, undefined);
});

test("already_has_access_names_where_it_comes_from", () => {
  const viaGroup = [step({ n: 2, kind: "role", permission: "files.view", role: { id: "c6f204bc-8cc0-55a4-b2e2-799dcda9120e", name: "Comptable", direct: false, viaGroups: [{ id: "5942db65-eba7-5ead-870b-a5161dae5802", name: "Comptabilité" }] } })];
  assert.equal(alreadyVia({ steps: viaGroup, result: [{ permission: "files.view", granted: true, reasonStep: 2 }] }, "files.view"), "Comptabilité");
  const rule = [step({ n: 3, kind: "rule", target: { kind: "group", id: "5942db65-eba7-5ead-870b-a5161dae5802", name: "Design", hidden: false } })];
  assert.equal(alreadyVia({ steps: rule, result: [{ permission: "files.view", granted: true, reasonStep: 3 }] }, "files.view"), "Design");
  // Not through a group or a role of their own: nothing to say. Nor when access is refused.
  const base = [step({ n: 1, kind: "base" })];
  assert.equal(alreadyVia({ steps: base, result: [{ permission: "files.view", granted: true, reasonStep: 1 }] }, "files.view"), undefined);
  assert.equal(alreadyVia({ steps: viaGroup, result: [{ permission: "files.view", granted: false, reasonStep: 2 }] }, "files.view"), undefined);
  const direct = [step({ n: 2, kind: "role", role: { id: "c6f204bc-8cc0-55a4-b2e2-799dcda9120e", name: "Comptable", direct: true, viaGroups: [] } })];
  assert.equal(alreadyVia({ steps: direct, result: [{ permission: "files.view", granted: true, reasonStep: 2 }] }, "files.view"), "Comptable");
});

test("why_names_the_place_and_level_of_a_rule", () => {
  const rule = (level: StepLike["level"], ruleLevel?: string) => [step({ n: 4, kind: "rule", permission: "files.edit", level, ruleLevel: ruleLevel as never, target: { kind: "group", id: "5942db65-eba7-5ead-870b-a5161dae5802", name: "Comptabilité", hidden: false } })];
  const result = { permission: "files.edit", granted: true, reasonStep: 4 };
  // A named place: its name, and the level in the words of that kind of resource.
  assert.deepEqual(cardOf(result, rule({ kind: "file", id: "4c440343-9480-50e5-b217-ff831ed67e79", name: "Compta", hidden: false }, "contribute")).reason, {
    n: 4, kind: "rule", where: "Compta", hiddenPlace: false, levelKey: "access.level.file.contribute",
  });
  assert.equal(cardOf(result, rule({ kind: "channel", id: "42b3314a-a7ba-5dc0-95b9-d25d35196de3", name: "compta", hidden: false }, "contribute")).reason?.levelKey, "access.level.channel.contribute");
  assert.equal(cardOf(result, rule({ kind: "calendar", id: "6c0d05b2-3229-5271-af34-15698f45781b", name: "Congés", hidden: false }, "read")).reason?.levelKey, "access.level.read");
  assert.equal(cardOf(result, rule({ kind: "file", id: "4c440343-9480-50e5-b217-ff831ed67e79", name: "Compta", hidden: false }, "custom")).reason?.levelKey, "access.level.custom");
  // A hidden place is said to be hidden, and carries no name.
  assert.deepEqual(cardOf(result, rule({ kind: "file", hidden: true }, "manage")).reason, { n: 4, kind: "rule", where: undefined, hiddenPlace: true, levelKey: "access.level.manage" });
  // A rule step without a level (an older server) stays a plain "par une regle".
  assert.deepEqual(cardOf(result, rule({ kind: "file", id: "4c440343-9480-50e5-b217-ff831ed67e79", name: "Compta", hidden: false })).reason, { n: 4, kind: "rule" });
  // Other kinds keep their short reason.
  for (const locale of ["fr", "en", "de", "es", "it", "pl"]) {
    const dict = JSON.parse(readFileSync(new URL(`../../lib/i18n/dictionaries/${locale}.json`, import.meta.url), "utf8")) as Record<string, unknown>;
    for (const key of ["why.reason.ruleOn", "why.reason.ruleOnHidden", "access.level.custom", "access.level.none"]) {
      assert.ok(key.split(".").reduce<unknown>((at, part) => (at as Record<string, unknown> | undefined)?.[part], dict) !== undefined, `${locale}: ${key}`);
    }
  }
});

const ID = { admin: "0b1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8", members: "1c2d3e4f-5061-4b72-9c83-a4b5c6d7e8f9", guests: "2d3e4f50-6172-4c83-8d94-b5c6d7e8f9a0", custom: "3e4f5061-7283-4d94-9ea5-c6d7e8f9a0b1" };
const roles = [
  { id: ID.admin, name: "Administrator", systemKey: "administrator" as const },
  { id: ID.members, name: "Members", systemKey: "members" as const },
  { id: ID.guests, name: "Guests", systemKey: "guests" as const },
  { id: ID.custom, name: "Comptable" },
];

test("why_names_system_roles_as_the_ui_does", () => {
  // The base roles come as @members and @guests: the UI says "Tout l'espace" and "Tous les invités".
  assert.deepEqual(labelOf({ kind: "everyone", name: "@members", hidden: false }, roles), { key: "channel.everyoneInSpace" });
  assert.deepEqual(labelOf({ kind: "everyone", name: "@guests", hidden: false }, roles), { key: "access.allGuests" });
  // The system roles are named by their stored English name: the UI translates them.
  assert.deepEqual(labelOf({ kind: "role", id: ID.admin, name: "Administrator", hidden: false }, roles), { key: "role.admin" });
  assert.deepEqual(labelOf({ kind: "role", id: ID.members, name: "Members", hidden: false }, roles), { key: "roles.everyone" });
  assert.deepEqual(labelOf({ kind: "role", id: ID.guests, name: "Guests", hidden: false }, roles), { key: "roles.guests" });
  // A role of the space's own keeps its name; a group or a person too.
  assert.deepEqual(labelOf({ kind: "role", id: ID.custom, name: "Comptable", hidden: false }, roles), { name: "Comptable" });
  assert.deepEqual(labelOf({ kind: "group", id: ID.custom, name: "Comptabilité", hidden: false }, roles), { name: "Comptabilité" });
  // Not in the list (the roles did not load): the stored name of a system role still reads right.
  assert.deepEqual(labelOf({ kind: "role", id: ID.admin, name: "Administrator", hidden: false }, []), { key: "role.admin" });
  assert.deepEqual(labelOf({ kind: "role", id: ID.custom, name: "Comptable", hidden: false }, []), { name: "Comptable" });
  // A hidden one says nothing, and the dialog words it.
  assert.deepEqual(labelOf({ kind: "audience", hidden: true }, roles), {});
  assert.deepEqual(labelOf(undefined, roles), {});
});

test("steps_of_one_origin_read_as_one_sentence", () => {
  const rule = { kind: "group", id: ID.custom, name: "Comptabilité", hidden: false };
  const folder = { kind: "file", id: ID.admin, name: "Compta", hidden: false };
  const steps: StepLike[] = [
    step({ n: 1, kind: "base", permission: "files.view" }),
    step({ n: 2, kind: "base", permission: "files.create" }),
    step({ n: 3, kind: "rule", permission: "files.edit", target: rule, level: folder, ruleLevel: "contribute" }),
    step({ n: 4, kind: "rule", permission: "files.create", target: rule, level: folder, ruleLevel: "contribute" }),
    step({ n: 5, kind: "base", permission: "files.manage", effect: "removed" }),
    step({ n: 6, kind: "rule", permission: "files.edit", target: rule, level: { ...folder, name: "2026" }, ruleLevel: "contribute" }),
  ];
  const groups = groupSteps(steps);
  assert.deepEqual(groups.map((g) => [g.n, g.kind, g.effect, g.permissions]), [
    [1, "base", "granted", ["files.view", "files.create"]],
    [3, "rule", "granted", ["files.edit", "files.create"]],
    [5, "base", "removed", ["files.manage"]],
    [6, "rule", "granted", ["files.edit"]],
  ]);
  // Every original step is still reachable for the result cards.
  assert.deepEqual(groups[1].ns, [3, 4]);
  assert.equal(groupSteps([]).length, 0);
});

test("a_quiet_lock_line_closes_the_explanation", () => {
  // No lock step at all: the three locks changed nothing, and the dialog says so (frame 9).
  assert.equal(locksQuiet([step({ kind: "base" }), step({ kind: "rule" })]), true);
  for (const kind of ["private_lock", "guest_ceiling", "owner", "archived"]) assert.equal(locksQuiet([step({ kind })]), false, kind);
  assert.equal(locksQuiet([]), true);
});
