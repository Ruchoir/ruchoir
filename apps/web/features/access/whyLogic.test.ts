import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { alreadyVia, cardOf, reasonKey, roleSentence, STEP_KINDS, stepSentence, type StepLike } from "./whyLogic.ts";

const step = (over: Partial<StepLike> = {}): StepLike => ({ n: 1, kind: "base", permission: "files.view", effect: "granted", ...over });

test("a_role_via_a_group_names_the_group", () => {
  const direct = roleSentence({ id: "r", name: "Comptable", direct: true, viaGroups: [] });
  assert.deepEqual(direct, { key: "why.role.direct", values: { role: "Comptable" } });
  const via = roleSentence({ id: "r", name: "Comptable", direct: false, viaGroups: [{ id: "g", name: "Comptabilité" }] });
  assert.deepEqual(via, { key: "why.role.viaGroup", values: { role: "Comptable", groups: "Comptabilité" } });
  const two = roleSentence({ id: "r", name: "Comptable", direct: false, viaGroups: [{ id: "g", name: "A" }, { id: "h", name: "B" }] });
  assert.equal(two.values.groups, "A, B");
  const both = roleSentence({ id: "r", name: "Comptable", direct: true, viaGroups: [{ id: "g", name: "A" }] });
  assert.equal(both.key, "why.role.directAndGroup");
  assert.equal(stepSentence(step({ kind: "role", role: { id: "r", name: "Comptable", direct: false, viaGroups: [{ id: "g", name: "A" }] } })).values.groups, "A");
});

test("every_step_kind_has_a_sentence", () => {
  assert.equal(STEP_KINDS.length, 13);
  for (const locale of ["fr", "en", "de", "es", "it", "pl"]) {
    const dict = JSON.parse(readFileSync(new URL(`../../lib/i18n/dictionaries/${locale}.json`, import.meta.url), "utf8")) as Record<string, unknown>;
    const has = (key: string) => key.split(".").reduce<unknown>((at, part) => (at as Record<string, unknown> | undefined)?.[part], dict) !== undefined;
    for (const kind of STEP_KINDS) {
      for (const effect of ["granted", "removed"] as const) {
        const { key } = stepSentence(step({ kind, effect, level: { kind: "file", id: "d", name: "Compta", hidden: false }, target: { kind: "group", id: "g", name: "Comptabilité", hidden: false } }));
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
  const s = stepSentence(step({ kind: "rule", level: { kind: "file", id: "d", name: "Compta", hidden: false }, target: { kind: "group", id: "g", name: "Comptabilité", hidden: false } }));
  assert.equal(s.key, "why.step.rule.granted");
  assert.equal(s.values.target, "Comptabilité");
  assert.equal(s.values.where, "Compta");
  const hidden = stepSentence(step({ kind: "rule", level: { kind: "file", hidden: true }, target: { kind: "audience", hidden: true } }));
  assert.equal(hidden.key, "why.step.rule.granted");
  assert.equal(hidden.values.where, "");
  assert.equal(hidden.values.target, "");
});

test("the_result_cards_match_the_decision", () => {
  const steps = [step({ n: 1, kind: "base" }), step({ n: 4, kind: "role", permission: "files.edit", role: { id: "r", name: "Comptable", direct: false, viaGroups: [{ id: "g", name: "Comptabilité" }] } })];
  const granted = cardOf({ permission: "files.edit", granted: true, reasonStep: 4 }, steps);
  assert.deepEqual(granted, { permission: "files.edit", granted: true, reason: { n: 4, kind: "role" } });
  const refused = cardOf({ permission: "files.manage", granted: false }, steps);
  assert.deepEqual(refused, { permission: "files.manage", granted: false, reason: undefined });
  const removed = cardOf({ permission: "files.view", granted: false, reasonStep: 9 }, steps);
  assert.equal(removed.reason, undefined);
});

test("already_has_access_names_where_it_comes_from", () => {
  const viaGroup = [step({ n: 2, kind: "role", permission: "files.view", role: { id: "r", name: "Comptable", direct: false, viaGroups: [{ id: "g", name: "Comptabilité" }] } })];
  assert.equal(alreadyVia({ steps: viaGroup, result: [{ permission: "files.view", granted: true, reasonStep: 2 }] }, "files.view"), "Comptabilité");
  const rule = [step({ n: 3, kind: "rule", target: { kind: "group", id: "g", name: "Design", hidden: false } })];
  assert.equal(alreadyVia({ steps: rule, result: [{ permission: "files.view", granted: true, reasonStep: 3 }] }, "files.view"), "Design");
  // Not through a group or a role of their own: nothing to say. Nor when access is refused.
  const base = [step({ n: 1, kind: "base" })];
  assert.equal(alreadyVia({ steps: base, result: [{ permission: "files.view", granted: true, reasonStep: 1 }] }, "files.view"), undefined);
  assert.equal(alreadyVia({ steps: viaGroup, result: [{ permission: "files.view", granted: false, reasonStep: 2 }] }, "files.view"), undefined);
  const direct = [step({ n: 2, kind: "role", role: { id: "r", name: "Comptable", direct: true, viaGroups: [] } })];
  assert.equal(alreadyVia({ steps: direct, result: [{ permission: "files.view", granted: true, reasonStep: 2 }] }, "files.view"), "Comptable");
});
