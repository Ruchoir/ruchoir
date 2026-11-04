import { test } from "node:test";
import assert from "node:assert/strict";

import { threadFooter } from "../src/logic/threadCompose.ts";

test("a_thread_of_a_channel_waits_for_the_channels_before_choosing_between_composer_and_note", () => {
  assert.equal(threadFooter({ signedIn: true, inChannel: true, channelsLoaded: false, canSend: true }), "waiting");
  assert.equal(threadFooter({ signedIn: true, inChannel: true, channelsLoaded: false, canSend: false }), "waiting");
});

test("once_loaded_the_footer_follows_the_right_to_write", () => {
  assert.equal(threadFooter({ signedIn: true, inChannel: true, channelsLoaded: true, canSend: true }), "composer");
  assert.equal(threadFooter({ signedIn: true, inChannel: true, channelsLoaded: true, canSend: false }), "readOnly");
});

test("a_conversation_thread_has_no_channel_to_wait_for_and_a_signed_out_phone_shows_nothing", () => {
  assert.equal(threadFooter({ signedIn: true, inChannel: false, channelsLoaded: false, canSend: true }), "composer");
  assert.equal(threadFooter({ signedIn: false, inChannel: true, channelsLoaded: true, canSend: true }), "none");
});
