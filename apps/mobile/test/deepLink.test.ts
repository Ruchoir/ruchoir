import { test } from "node:test";
import assert from "node:assert/strict";

import { linkAllowed, linkServer, linkTarget } from "../src/logic/deepLink.ts";

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

test("a_link_may_name_its_instance", () => {
  assert.equal(linkServer("ruchoir://event/e1?start=x&server=https%3A%2F%2Fb.test"), "https://b.test");
  assert.equal(linkServer("ruchoir://conversation/c1?title=T&server=http%3A%2F%2Fplain.test"), undefined);
  assert.equal(linkServer("ruchoir://agenda"), undefined);
});

test("the_reminder_mails_prolong_link_opens_that_guest", () => {
  const guest = "0b9f7a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
  assert.deepEqual(linkTarget(`https://app.test/e/atelier?prolong=${guest}`), { screen: "prolong", spaceSlug: "atelier", userId: guest });
  assert.deepEqual(linkTarget(`https://app.test/e/atelier/?prolong=${guest.toUpperCase()}`), { screen: "prolong", spaceSlug: "atelier", userId: guest });
  assert.equal(linkTarget("https://app.test/e/atelier?prolong=not-an-id"), null);
  assert.equal(linkTarget(`https://app.test/e/atelier/c/general?prolong=${guest}`), null);
});

test("the_prolong_link_names_its_instance_when_it_is_a_web_address", () => {
  const guest = "0b9f7a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
  assert.equal(linkServer(`https://App.Test/e/atelier?prolong=${guest}`), "https://app.test");
  assert.equal(linkServer(`ruchoir://e/atelier?prolong=${guest}`), undefined);
});

test("a_prolong_link_with_a_broken_escape_is_not_a_link", () => {
  const guest = "0b9f7a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
  assert.equal(linkTarget(`https://app.test/e/at%zzlier?prolong=${guest}`), null);
  assert.equal(linkTarget(`ruchoir://e/%E0%A4%A?prolong=${guest}`), null);
});

test("an_encoded_space_slug_is_decoded", () => {
  const guest = "0b9f7a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
  assert.deepEqual(linkTarget(`https://app.test/e/atelier%20rennes?prolong=${guest}`), { screen: "prolong", spaceSlug: "atelier rennes", userId: guest });
});

test("the_app_scheme_carries_the_prolong_link_too", () => {
  const guest = "0b9f7a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
  assert.deepEqual(linkTarget(`ruchoir://e/atelier?prolong=${guest}`), { screen: "prolong", spaceSlug: "atelier", userId: guest });
});

test("a_prolong_link_is_followed_only_for_an_instance_the_phone_knows", () => {
  const guest = "0b9f7a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
  const known = ["https://app.test"];
  assert.equal(linkAllowed(`https://App.Test/e/atelier?prolong=${guest}`, known), true);
  assert.equal(linkAllowed(`https://evil.test/e/atelier?prolong=${guest}`, known), false);
  assert.equal(linkAllowed(`ruchoir://e/atelier?prolong=${guest}`, known), true);
  assert.equal(linkAllowed("ruchoir://agenda", []), true);
});
