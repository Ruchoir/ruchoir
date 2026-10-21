import { test } from "node:test";
import assert from "node:assert/strict";

import { pushKind, toDismiss, type Shown } from "../src/push/sync.ts";

test("an_iphone_background_push_is_a_sync", () => {
  assert.equal(pushKind({ notification: null, data: {}, aps: { "content-available": 1 } }), "sync");
});

test("an_android_data_message_says_which_it_is", () => {
  assert.equal(pushKind({ notification: null, data: { ruchoir: "sync" } }), "sync");
  assert.equal(pushKind({ notification: null, data: { ruchoir: "wake" } }), "wake");
  // Some versions hand the data as a JSON string.
  assert.equal(pushKind({ notification: null, data: { dataString: '{"ruchoir":"sync"}' } }), "sync");
  assert.equal(pushKind({ notification: null, data: { dataString: '{"ruchoir":"wake"}' } }), "wake");
});

test("on_android_anything_but_a_sync_wakes_as_before", () => {
  // Before the sync push existed, every data message woke the app: a shape we do not recognise must
  // not stop new messages from showing.
  assert.equal(pushKind({ notification: null, data: {} }), "wake");
  assert.equal(pushKind({ notification: null, data: { dataString: "not json" } }), "wake");
  assert.equal(pushKind({ notification: null }), "wake");
});

test("anything_else_is_left_alone", () => {
  assert.equal(pushKind(null), null);
  assert.equal(pushKind({ actionIdentifier: "tap", notification: {} }), null);
  // An alert reaching the task on an iPhone: the extension already dealt with it.
  assert.equal(pushKind({ notification: null, data: {}, aps: { alert: { title: "Ruchoir" }, "mutable-content": 1 } }), null);
});

const A = "https://a.test";
const B = "https://b.test";
const shown = (identifier: string, server?: string, notificationId?: string): Shown => ({ identifier, server, notificationId });

test("a_notification_read_on_its_instance_leaves_the_screen", () => {
  const answers = new Map([[A, { unread: new Set(["n2"]), complete: true }]]);
  assert.deepEqual(toDismiss([shown("x1", A, "n1"), shown("x2", A, "n2")], answers, false), ["x1"]);
});

test("an_instance_that_did_not_answer_keeps_its_notifications", () => {
  const answers = new Map([[A, { unread: new Set<string>(), complete: true }]]);
  assert.deepEqual(toDismiss([shown("x1", B, "n1")], answers, false), []);
});

test("an_unread_list_cut_short_dismisses_nothing_it_cannot_see", () => {
  // More unread than one page: n1 may be among the older ones still unread.
  const answers = new Map([[A, { unread: new Set(["n9"]), complete: false }]]);
  assert.deepEqual(toDismiss([shown("x1", A, "n1")], answers, false), []);
});

test("a_notification_that_does_not_say_where_it_comes_from_goes_only_when_nothing_is_unread", () => {
  // "New activity", or one drawn by an older version of the app.
  const answers = new Map([[A, { unread: new Set<string>(), complete: true }]]);
  assert.deepEqual(toDismiss([shown("x1"), shown("x2", A)], answers, false), []);
  assert.deepEqual(toDismiss([shown("x1"), shown("x2", A)], answers, true), ["x1", "x2"]);
});
