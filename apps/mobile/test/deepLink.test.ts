import { test } from "node:test";
import assert from "node:assert/strict";

import { linkTarget } from "../src/logic/deepLink.ts";

test("the_widgets_shortcuts_open_their_screens", () => {
  assert.deepEqual(linkTarget("ruchoir://new-event"), { screen: "eventForm" });
  assert.deepEqual(linkTarget("ruchoir://agenda"), { screen: "tab", tab: "agenda" });
  assert.deepEqual(linkTarget("ruchoir://add-file"), { screen: "addFile" });
  assert.deepEqual(linkTarget("ruchoir://search"), { screen: "search" });
  assert.deepEqual(linkTarget("ruchoir://event/e1?start=2026-06-16T12:00:00Z"), { screen: "event", eventId: "e1", start: "2026-06-16T12:00:00Z" });
  assert.deepEqual(linkTarget("ruchoir://discussions"), { screen: "tab", tab: "discussions" });
  assert.deepEqual(linkTarget("ruchoir://files"), { screen: "tab", tab: "files" });
  assert.deepEqual(linkTarget("ruchoir://new-message"), { screen: "newMessage" });
  assert.deepEqual(linkTarget("ruchoir:///agenda"), { screen: "tab", tab: "agenda" });
});

test("a_conversation_link_opens_it", () => {
  assert.deepEqual(linkTarget("ruchoir://conversation/c1?space=s1&title=G%C3%A9n%C3%A9ral&channel=1"), {
    screen: "conversation",
    spaceId: "s1",
    params: { conversationId: "c1", title: "Général", channelId: "c1", kind: "channel" },
  });
});

test("the_sign_in_returns_and_anything_else_are_left_alone", () => {
  // ruchoir://auth and ruchoir://passkey belong to the browser sign-in (auth/browser.ts).
  assert.equal(linkTarget("ruchoir://auth?code=x"), null);
  assert.equal(linkTarget("ruchoir://passkey?added=1"), null);
  assert.equal(linkTarget("ruchoir://expo-development-client/?url=https%3A%2F%2Fx"), null);
  assert.equal(linkTarget("https://ruchoir.com/agenda"), null);
  assert.equal(linkTarget("ruchoir://conversation/"), null);
});
