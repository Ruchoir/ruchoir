import { test } from "node:test";
import assert from "node:assert/strict";

import {
  addInstance,
  EMPTY_REGISTRY,
  findByOrigin,
  migrateLegacy,
  parseRegistry,
  removeInstance,
  setActive,
  setLastSpace,
} from "../src/accounts/registry.ts";

const A = { id: "a", origin: "https://a.test" };
const B = { id: "b", origin: "https://b.test" };
const C = { id: "c", origin: "https://c.test" };

test("an_update_keeps_the_instance_and_its_last_space", () => {
  const registry = migrateLegacy("https://a.test", "s1", "a");
  assert.deepEqual(registry, { instances: [A], active: "a", lastSpace: { a: "s1" } });
});

test("adding_makes_the_new_instance_active", () => {
  const registry = addInstance(addInstance(EMPTY_REGISTRY, A), B);
  assert.deepEqual(registry.instances, [A, B]);
  assert.equal(registry.active, "b");
});

test("adding_a_known_origin_only_activates_it", () => {
  const registry = addInstance(addInstance(addInstance(EMPTY_REGISTRY, A), B), { id: "other", origin: "https://a.test" });
  assert.deepEqual(registry.instances, [A, B]);
  assert.equal(registry.active, "a");
  assert.equal(findByOrigin(registry, "https://a.test")?.id, "a");
});

test("removing_the_active_one_activates_its_neighbour", () => {
  const three = setActive(addInstance(addInstance(addInstance(EMPTY_REGISTRY, A), B), C), "b");
  assert.equal(removeInstance(three, "b").active, "c");
  assert.equal(removeInstance(setActive(three, "c"), "c").active, "b");
  assert.equal(removeInstance(setActive(three, "a"), "b").active, "a");
  assert.equal(removeInstance(addInstance(EMPTY_REGISTRY, A), "a").active, null);
});

test("removing_forgets_the_last_space", () => {
  const registry = setLastSpace(addInstance(addInstance(EMPTY_REGISTRY, A), B), "a", "s1");
  assert.deepEqual(removeInstance(registry, "a").lastSpace, {});
});

test("a_damaged_registry_reads_as_empty", () => {
  assert.deepEqual(parseRegistry("{not json"), EMPTY_REGISTRY);
  assert.deepEqual(parseRegistry(null), EMPTY_REGISTRY);
  const odd = parseRegistry(JSON.stringify({ instances: [A, { id: 3 }], active: "gone", lastSpace: { a: "s" } }));
  assert.deepEqual(odd, { instances: [A], active: "a", lastSpace: { a: "s" } });
});
