// Run with `pnpm --filter @ruchoir/client test` (Node's own runner, types stripped by Node).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { joinSentences, levelWordKey, cardsOf, outline, locksQuiet, groupSteps, labelOf, alreadyVia, cardOf, reasonKey, roleSentence, STEP_KINDS, stepSentence, type StepLike } from "../src/permissionsLogic/why.ts";

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
    const dict = JSON.parse(readFileSync(new URL(`../../../apps/web/lib/i18n/dictionaries/${locale}.json`, import.meta.url), "utf8")) as Record<string, unknown>;
    const has = (key: string) => key.split(".").reduce<unknown>((at, part) => (at as Record<string, unknown> | undefined)?.[part], dict) !== undefined;
    // A sentence whose verb agrees with the permissions is held as its plural forms (`_one`, `_other`...).
    const hasSentence = (key: string) => has(key) || has(`${key}_other`);
    for (const kind of STEP_KINDS) {
      for (const effect of ["granted", "removed"] as const) {
        const { key } = stepSentence(step({ kind, effect, level: { kind: "file", id: "4c440343-9480-50e5-b217-ff831ed67e79", name: "Compta", hidden: false }, target: { kind: "group", id: "5942db65-eba7-5ead-870b-a5161dae5802", name: "Comptabilité", hidden: false } }));
        assert.ok(hasSentence(key), `${locale}: ${key}`);
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
    const dict = JSON.parse(readFileSync(new URL(`../../../apps/web/lib/i18n/dictionaries/${locale}.json`, import.meta.url), "utf8")) as Record<string, unknown>;
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

const R = (permission: string, granted: boolean, reasonStep?: number) => ({ permission, granted, reasonStep });

test("results_read_in_levels", () => {
  const steps: StepLike[] = [
    step({ n: 1, kind: "base", permission: "files.view" }),
    step({ n: 2, kind: "rule", permission: "files.create", target: { kind: "group", id: ID.custom, name: "Comptabilité", hidden: false }, level: { kind: "file", id: ID.admin, name: "Compta", hidden: false }, ruleLevel: "contribute" }),
    step({ n: 3, kind: "rule", permission: "files.edit", target: { kind: "group", id: ID.custom, name: "Comptabilité", hidden: false }, level: { kind: "file", id: ID.admin, name: "Compta", hidden: false }, ruleLevel: "contribute" }),
  ];
  const files = cardsOf("file", [R("files.view", true, 1), R("files.create", true, 2), R("files.edit", true, 3), R("files.manage", false), R("files.public_link", false)], steps);
  assert.deepEqual(files.map((c) => [c.labelKey, c.granted]), [
    ["why.card.view", true], ["access.level.file.contribute", true], ["access.level.manage", false], ["access.publicLink", false],
  ]);
  assert.equal(files[0].reason?.kind, "base");
  assert.equal(files[1].reason?.levelKey, "access.level.file.contribute");
  // "Modifier" needs both create and edit; one alone is not the level.
  const half = cardsOf("file", [R("files.view", true, 1), R("files.create", true, 2), R("files.edit", false), R("files.manage", false), R("files.public_link", false)], steps);
  assert.equal(half[1].granted, false);
  // Without the right to manage, the public link asks to be a manager; the others have no rule.
  assert.equal(files[3].hint, "askManage");
  assert.equal(files[2].hint, undefined);
  // Channels and calendars: Voir, Participer or Écrire, Gérer.
  const channel = cardsOf("channel", [R("channel.view", true, 1), R("message.send", true, 1), R("message.attach", true, 1), R("message.pin", true, 1), R("message.manage", false), R("channel.members.manage", false), R("channel.manage", false)], steps);
  assert.deepEqual(channel.map((c) => [c.labelKey, c.granted]), [["why.card.view", true], ["access.level.channel.contribute", true], ["access.level.manage", false]]);
  const calendar = cardsOf("calendar", [R("calendar.view", true, 1), R("calendar.write", false), R("calendar.manage", false)], steps);
  assert.deepEqual(calendar.map((c) => c.labelKey), ["why.card.view", "access.level.calendar.contribute", "access.level.manage"]);
  // A permission the explanation does not list leaves its level out.
  assert.equal(cardsOf("calendar", [R("calendar.view", true, 1)], steps).length, 1);
});

test("why_reads_as_the_chain_of_levels", () => {
  const group = { kind: "group", id: ID.custom, name: "Comptabilité", hidden: false };
  const compta = { kind: "file", id: ID.admin, name: "Compta", hidden: false };
  const steps: StepLike[] = [
    step({ n: 1, kind: "base", permission: "files.view" }),
    step({ n: 2, kind: "role", permission: "files.view", role: { id: ID.custom, name: "Comptable", direct: false, viaGroups: [{ id: ID.custom, name: "Comptabilité" }] } }),
    step({ n: 3, kind: "rule", permission: "files.edit", target: group, level: compta, ruleLevel: "contribute" }),
    step({ n: 4, kind: "rule", permission: "files.create", target: group, level: compta, ruleLevel: "contribute" }),
  ];
  const chain = [{ id: ID.admin, name: "Compta", item: false }, { id: ID.members, name: "2026", item: false }, { id: ID.guests, name: "Devis", item: true }];
  // The person's own list: Communication grants nothing here, so no step names it, yet it is listed.
  const held = [
    { id: ID.custom, name: "Comptable", direct: false, viaGroups: [{ id: ID.custom, name: "Comptabilité" }] },
    { id: ID.guests, name: "Communication", direct: false, viaGroups: [{ id: ID.guests, name: "Communication" }] },
  ];
  const para = outline(steps, chain, held);
  assert.deepEqual(para.map((p) => p.type), ["base", "roles", "space", "level", "level", "level", "quiet"]);
  // The roles line comes from the role steps, with the groups that carry them.
  const roles = para[1];
  assert.equal(roles.type === "roles" && roles.roles[0].viaGroups[0].name, "Comptabilité");
  assert.deepEqual(roles.type === "roles" && roles.roles.map((r) => r.name), ["Comptable", "Communication"]);
  // Without the person's list (an older server), the roles the steps name still show.
  assert.deepEqual(outline(steps, chain).find((p) => p.type === "roles")?.type === "roles" && (outline(steps, chain).find((p) => p.type === "roles") as { roles: { name: string }[] }).roles.map((r) => r.name), ["Comptable"]);
  // A person with no role beyond the base has no roles line.
  assert.equal(outline([step({ kind: "base" })], chain, []).some((p) => p.type === "roles"), false);
  // One line per level of the chain, outermost first; a rule's permissions are grouped in one sentence.
  const levels = para.filter((p) => p.type === "level");
  assert.deepEqual(levels.map((l) => l.type === "level" && [l.name, l.item, l.rules.length]), [["Compta", false, 1], ["2026", false, 0], ["Devis", true, 0]]);
  assert.deepEqual(levels[0].type === "level" && levels[0].rules[0].permissions, ["files.edit", "files.create"]);
  // A lock that acted replaces the quiet line.
  const locked = outline([...steps, step({ n: 5, kind: "guest_ceiling", effect: "removed", permission: "files.manage" })], chain);
  assert.equal(locked.at(-1)?.type, "locks");
  assert.equal(locked.some((p) => p.type === "quiet"), false);
  // A rule at a place the chain does not know (hidden) still appears, before the locks.
  const hidden = outline([...steps, step({ n: 6, kind: "rule", permission: "files.view", target: group, level: { kind: "file", hidden: true }, ruleLevel: "read" })], chain);
  assert.equal(hidden.filter((p) => p.type === "level").length, 4);
  // Other kinds of step (a message the file was shared in...) stay plain sentences.
  assert.equal(outline([step({ kind: "message", permission: "files.view" })], chain).some((p) => p.type === "other"), true);
});

test("a_folder_item_is_called_a_folder", () => {
  // Folders and files are both `file` on the wire: the word follows what is being explained.
  assert.equal(levelWordKey({ item: true, hidden: false }, "file", true), "files.typeFolder");
  assert.equal(levelWordKey({ item: true, hidden: false }, "file", false), "message.file");
  assert.equal(levelWordKey({ item: true, hidden: false }, "channel", false), "calendar.channel");
  assert.equal(levelWordKey({ item: true, hidden: false }, "calendar", false), "calendar.title");
  // Every level above the item is a folder, whatever the item is.
  assert.equal(levelWordKey({ item: false, hidden: false }, "file", false), "files.typeFolder");
  assert.equal(levelWordKey({ item: false, hidden: true }, "file", false), undefined);
});

test("joined_rule_sentences_start_with_a_capital", () => {
  assert.equal(joinSentences(["une règle donne A. Hugo en fait partie.", "une règle retire B."]), "une règle donne A. Hugo en fait partie. Une règle retire B.");
  assert.equal(joinSentences(["only one"]), "only one");
  assert.equal(joinSentences([]), "");
  // Locales with their own capital rules: the first letter only, in the reader's language.
  assert.equal(joinSentences(["a", "ärger"], "de"), "a Ärger");
  assert.equal(joinSentences(["a", "ilk"], "tr"), "a İlk");
});

test("a_granted_rule_agrees_with_the_number_of_permissions", () => {
  const plural = (locale: string, key: string, count: number) => {
    const dict = JSON.parse(readFileSync(new URL(`../../../apps/web/lib/i18n/dictionaries/${locale}.json`, import.meta.url), "utf8")) as Record<string, unknown>;
    const lookup = (k: string) => k.split(".").reduce<unknown>((at, p) => (at as Record<string, unknown> | undefined)?.[p], dict) as string | undefined;
    const form = new Intl.PluralRules(locale).select(count);
    return lookup(`${key}_${form}`) ?? lookup(`${key}_other`);
  };
  const frOne = plural("fr", "why.para.rule.granted", 1);
  const frTwo = plural("fr", "why.para.rule.granted", 2);
  assert.ok(frOne?.includes("lui est accordé"), frOne);
  assert.ok(frTwo?.includes("lui sont accordés"), frTwo);
  for (const locale of ["en", "de", "es", "it", "pl"]) {
    const one = plural(locale, "why.para.rule.granted", 1);
    const two = plural(locale, "why.para.rule.granted", 2);
    assert.ok(one && two && one !== two, `${locale}: one and several differ`);
  }
});

test("a_level_a_rule_gave_and_the_guest_ceiling_took_names_the_ceiling", () => {
  const person = { kind: "group", id: ID.custom, name: "Comptabilité", hidden: false };
  const place = { kind: "channel", id: ID.admin, name: "compta", hidden: false };
  const steps: StepLike[] = [
    step({ n: 1, kind: "base", permission: "channel.view" }),
    step({ n: 2, kind: "rule", permission: "message.manage", target: person, level: place, ruleLevel: "manage" }),
    step({ n: 3, kind: "guest_ceiling", permission: "message.manage", effect: "removed" }),
    step({ n: 4, kind: "guest_ceiling", permission: "channel.manage", effect: "removed" }),
  ];
  const cards = cardsOf("channel", [R("channel.view", true, 1), R("message.send", true, 1), R("message.manage", false, 3), R("channel.members.manage", false), R("channel.manage", false, 4)], steps);
  const manage = cards.find((c) => c.id === "manage");
  assert.equal(manage?.granted, false);
  assert.equal(manage?.reason?.kind, "guest_ceiling");
  assert.equal(reasonKey(manage!.reason!.kind), "why.reason.guest_ceiling");
  // A level nothing touched keeps saying that no rule grants it.
  const none = cardsOf("channel", [R("channel.view", true, 1), R("message.manage", false), R("channel.members.manage", false), R("channel.manage", false)], steps.slice(0, 1));
  assert.equal(none.find((c) => c.id === "manage")?.reason, undefined);
  // A removal the result does not point at is still found among the steps of that level.
  const unpointed = cardsOf("channel", [R("channel.view", true, 1), R("message.manage", false), R("channel.members.manage", false), R("channel.manage", false)], steps);
  assert.equal(unpointed.find((c) => c.id === "manage")?.reason?.kind, "guest_ceiling");
});

test("a_step_sentence_counts_its_permissions_so_the_verb_agrees", () => {
  const group = { ...step({ kind: "guest_ceiling", effect: "removed" }), permissions: ["files.create", "files.edit"], ns: [1, 2] };
  assert.equal(stepSentence(group).count, 2);
  assert.equal(stepSentence(step({ kind: "guest_ceiling", effect: "removed" })).count, 1);
  assert.equal(stepSentence(step({ kind: "from_the_future" })).count, 1);
});

test("the_sentences_with_a_verb_on_the_permissions_have_a_plural_form_in_every_language", () => {
  const agreeing = ["role.granted", "private_lock.removed", "guest_ceiling.granted", "guest_ceiling.removed", "owner.granted", "owner.removed", "author.granted", "author.removed", "archived.granted", "archived.removed", "joined.granted", "joined.removed", "unseen.granted", "unseen.removed", "conversation.granted", "conversation.removed", "message.granted", "message.removed", "event.granted", "event.removed"];
  for (const app of ["apps/web/lib/i18n/dictionaries", "apps/mobile/src/i18n/dictionaries"]) {
    for (const locale of ["fr", "en", "de", "es", "it", "pl"]) {
      const dict = JSON.parse(readFileSync(new URL(`../../../${app}/${locale}.json`, import.meta.url), "utf8")) as { why: { step: Record<string, Record<string, string>> } };
      // French is the source dictionary and keeps `one` and `other` (as every plural key of it does).
      const categories = locale === "fr" ? ["one", "other"] : new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
      for (const path of agreeing) {
        const [kind, effect] = path.split(".");
        const entry = dict.why.step[kind];
        const forms = categories.map((c) => entry[`${effect}_${c}`]);
        for (const [i, c] of categories.entries()) assert.ok(forms[i], `${app} ${locale} ${path}_${c}`);
        // French is the source: its verb always changes ("dépasse" / "dépassent").
        if (locale === "fr") assert.notEqual(entry[`${effect}_one`], entry[`${effect}_other`], `${app} fr ${path}`);
      }
    }
  }
});
