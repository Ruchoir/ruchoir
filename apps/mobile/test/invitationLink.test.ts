import { test } from "node:test";
import assert from "node:assert/strict";

import { parseInvitationLink } from "../src/logic/invitationLink.ts";

const TOKEN = "a".repeat(32) + "0123456789abcdef0123456789abcdef";

test("a_link_names_its_server_and_token", () => {
  assert.deepEqual(parseInvitationLink(`https://Alpha.Ruchoir.com/invite?token=${TOKEN}`, null), {
    origin: "https://alpha.ruchoir.com",
    token: TOKEN,
  });
});

test("a_trailing_slash_spaces_and_other_parameters_are_forgiven", () => {
  assert.deepEqual(parseInvitationLink(`  https://a.test/invite/?lang=fr&token=${TOKEN}#x \n`, null), {
    origin: "https://a.test",
    token: TOKEN,
  });
});

test("a_bare_token_belongs_to_the_current_server", () => {
  assert.deepEqual(parseInvitationLink(TOKEN.toUpperCase(), "https://b.test"), { origin: "https://b.test", token: TOKEN });
  assert.equal(parseInvitationLink(TOKEN, null), null);
});

test("anything_else_is_not_an_invitation", () => {
  assert.equal(parseInvitationLink("", "https://b.test"), null);
  assert.equal(parseInvitationLink(`http://a.test/invite?token=${TOKEN}`, null), null);
  assert.equal(parseInvitationLink(`https://a.test/reset-password?token=${TOKEN}`, null), null);
  assert.equal(parseInvitationLink("https://a.test/invite?token=short", null), null);
  assert.equal(parseInvitationLink("bonjour", "https://b.test"), null);
});
