import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { configureClient, connectRealtime, resetClientForTests, type ChannelMembership } from "../src/index.ts";

/** A socket that delivers the frames a test hands it. */
class FakeSocket {
  readyState = 1;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { wasClean: boolean }) => void;
  onerror?: () => void;
  send() {}
  close() {}
  deliver(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

beforeEach(() => resetClientForTests());

test("a_membership_change_reaches_its_handler", () => {
  let socket: FakeSocket | null = null;
  configureClient({
    baseUrl: "https://a.test",
    openSocket: () => {
      socket = new FakeSocket();
      return socket as unknown as WebSocket;
    },
  });
  const heard: ChannelMembership[] = [];
  const connection = connectRealtime({ onChannelMembership: (change) => heard.push(change) });
  socket!.deliver({
    type: "channel.membership",
    payload: { space_id: "s1", channel_id: "c1", user_id: "u2", change: "role", role: "admin" },
  });
  socket!.deliver({ type: "channel.membership", payload: { space_id: "s1", channel_id: "c1", user_id: "u2", change: "removed" } });
  connection.close();
  assert.deepEqual(heard, [
    { spaceId: "s1", channelId: "c1", userId: "u2", change: "role", role: "admin" },
    { spaceId: "s1", channelId: "c1", userId: "u2", change: "removed", role: undefined },
  ]);
});
