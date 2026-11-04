// Run with `pnpm --filter @ruchoir/client test` (Node's own runner, types stripped by Node).
import { test } from "node:test";
import assert from "node:assert/strict";

import { channelGates } from "../src/permissionsLogic/channelGates.ts";

const member = { role: "member", myPermissions: ["channels.create"] };
const READ = ["channel.view", "message.react"];
const TAKE_PART = [...READ, "message.send", "message.attach", "message.pin", "message.mention_all"];
const MANAGE = [...TAKE_PART, "message.manage", "channel.members.manage", "channel.manage"];

test("a_reader_sees_the_channel_and_nothing_to_write_with", () => {
  const g = channelGates({ myPermissions: READ }, member, true);
  assert.equal(g.send, false);
  assert.equal(g.attach, false);
  assert.equal(g.pin, false);
  assert.equal(g.react, true);
  assert.equal(g.manage, false);
});

test("a_participant_writes_pins_and_mentions_everyone_without_moderating", () => {
  const g = channelGates({ myPermissions: TAKE_PART }, member, true);
  assert.deepEqual([g.send, g.attach, g.pin, g.mentionAll, g.react], [true, true, true, true, true]);
  assert.deepEqual([g.moderate, g.manageMembers, g.manage], [false, false, false]);
});

test("a_manager_runs_the_channel_but_deleting_it_is_the_spaces_right", () => {
  const g = channelGates({ myPermissions: MANAGE }, member, true);
  assert.deepEqual([g.moderate, g.manageMembers, g.manage, g.addPeople], [true, true, true, true]);
  assert.equal(g.remove, false, "channels.delete is held at the space level");
  assert.equal(channelGates({ myPermissions: MANAGE }, { role: "member", myPermissions: ["channels.delete"] }, true).remove, true);
});

test("an_admin_by_role_is_not_read_when_the_server_speaks_permissions", () => {
  const g = channelGates({ myPermissions: READ }, { role: "admin", myPermissions: [] }, true);
  assert.equal(g.moderate, false);
  assert.equal(g.send, false);
});

test("an_older_instance_falls_back_on_the_role", () => {
  const admin = channelGates({}, { role: "admin" }, false);
  assert.deepEqual([admin.manage, admin.moderate, admin.remove, admin.send, admin.pin], [true, true, true, true, true]);
  const plain = channelGates({}, { role: "member" }, false);
  assert.deepEqual([plain.manage, plain.moderate, plain.remove], [false, false, false]);
  assert.deepEqual([plain.send, plain.react, plain.attach, plain.pin], [true, true, true, true]);
  const guest = channelGates({}, { role: "guest" }, false);
  assert.deepEqual([guest.pin, guest.moderate, guest.manage], [false, false, false]);
  assert.equal(guest.send, true);
});

test("an_owner_of_the_channel_moderates_it_on_an_older_instance", () => {
  const g = channelGates({}, { role: "member" }, false, "admin");
  assert.deepEqual([g.moderate, g.manage, g.manageMembers], [true, true, true]);
  assert.equal(g.remove, false);
});

test("a_channel_without_permissions_on_a_new_instance_uses_the_fallback", () => {
  const g = channelGates({}, member, true);
  assert.equal(g.send, true);
  assert.equal(g.manage, false);
});

import { createGates } from "../src/permissionsLogic/channelGates.ts";

test("creating_follows_the_space_rights_when_the_server_speaks_them", () => {
  const none = createGates({ role: "member", myPermissions: ["channel.view"] }, true);
  assert.deepEqual([none.channel, none.dm, none.calendar], [false, false, false]);
  const all = createGates({ role: "member", myPermissions: ["channels.create", "dm.start", "calendars.create"] }, true);
  assert.deepEqual([all.channel, all.dm, all.calendar], [true, true, true]);
});

test("creating_on_an_older_instance_is_for_everyone_but_guests", () => {
  const member = createGates({ role: "member" }, false);
  assert.deepEqual([member.channel, member.dm, member.calendar], [true, true, true]);
  const guest = createGates({ role: "guest" }, false);
  assert.deepEqual([guest.channel, guest.calendar], [false, false]);
  assert.equal(guest.dm, true);
});
