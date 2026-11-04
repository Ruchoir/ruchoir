import assert from "node:assert/strict";
import { test } from "node:test";

import { channelOrderDoor, stepChannel } from "../src/logic/channelOrder.ts";

test("a_step_swaps_the_channel_with_its_neighbour", () => {
  assert.deepEqual(stepChannel(["a", "b", "c"], "b", -1), ["b", "a", "c"]);
  assert.deepEqual(stepChannel(["a", "b", "c"], "b", 1), ["a", "c", "b"]);
});

test("the_ends_and_unknown_channels_do_not_move", () => {
  assert.equal(stepChannel(["a", "b"], "a", -1), null);
  assert.equal(stepChannel(["a", "b"], "b", 1), null);
  assert.equal(stepChannel(["a", "b"], "x", 1), null);
});

test("the_input_order_is_left_untouched", () => {
  const order = ["a", "b"];
  stepChannel(order, "a", 1);
  assert.deepEqual(order, ["a", "b"]);
});

test("the_door_follows_the_space_settings_right", () => {
  assert.equal(channelOrderDoor(true, { reorderChannels: true }, false), true);
  assert.equal(channelOrderDoor(true, { reorderChannels: false }, true), false);
  assert.equal(channelOrderDoor(false, { reorderChannels: false }, true), true);
  assert.equal(channelOrderDoor(false, { reorderChannels: false }, false), false);
});
