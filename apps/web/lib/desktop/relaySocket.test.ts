import { test } from "node:test";
import assert from "node:assert/strict";

import { createRelaySocket, type Invoke, type Listen } from "./relaySocket.ts";

/** A stand-in for Tauri's events and commands. */
function fakeTauri(openAtStart: boolean) {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  const invoked: { cmd: string; args: Record<string, unknown> }[] = [];
  const listen: Listen = async (event, handler) => {
    const set = handlers.get(event) ?? new Set();
    set.add(handler);
    handlers.set(event, set);
    return () => set.delete(handler);
  };
  const invoke: Invoke = async (cmd, args = {}) => {
    invoked.push({ cmd, args });
    return cmd === "socket_is_open" ? openAtStart : undefined;
  };
  const emit = (event: string, payload: unknown) => handlers.get(event)?.forEach((h) => h(payload));
  const count = (event: string) => handlers.get(event)?.size ?? 0;
  return { listen, invoke, emit, invoked, count };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("opens_at_once_when_the_watcher_is_already_connected", async () => {
  const tauri = fakeTauri(true);
  const socket = createRelaySocket("a", tauri.listen, tauri.invoke);
  let opened = 0;
  socket.onopen = () => (opened += 1);
  assert.equal(socket.readyState, 0);
  await tick();
  assert.equal(socket.readyState, 1);
  assert.equal(opened, 1);
});

test("waits_for_its_own_instance_to_open", async () => {
  const tauri = fakeTauri(false);
  const socket = createRelaySocket("a", tauri.listen, tauri.invoke);
  let opened = 0;
  socket.onopen = () => (opened += 1);
  await tick();
  assert.equal(socket.readyState, 0);
  tauri.emit("socket:open", { instance: "b" });
  assert.equal(opened, 0);
  tauri.emit("socket:open", { instance: "a" });
  assert.equal(socket.readyState, 1);
  assert.equal(opened, 1);
});

test("delivers_only_its_instance_frames", async () => {
  const tauri = fakeTauri(true);
  const socket = createRelaySocket("a", tauri.listen, tauri.invoke);
  const got: string[] = [];
  socket.onmessage = (event: MessageEvent) => got.push(event.data as string);
  await tick();
  tauri.emit("socket:message", { instance: "b", frame: "nope" });
  tauri.emit("socket:message", { instance: "a", frame: '{"type":"x"}' });
  assert.deepEqual(got, ['{"type":"x"}']);
});

test("a_drop_closes_cleanly_and_stops_listening", async () => {
  const tauri = fakeTauri(true);
  const socket = createRelaySocket("a", tauri.listen, tauri.invoke);
  const closes: boolean[] = [];
  socket.onclose = (event: CloseEvent) => closes.push(event.wasClean);
  await tick();
  tauri.emit("socket:closed", { instance: "a" });
  assert.equal(socket.readyState, 3);
  assert.deepEqual(closes, [true]);
  await tick();
  assert.equal(tauri.count("socket:message"), 0);
  // A frame after the close is not delivered and does not reopen it.
  tauri.emit("socket:open", { instance: "a" });
  assert.equal(socket.readyState, 3);
});

test("send_goes_to_its_instance_and_close_unlistens", async () => {
  const tauri = fakeTauri(true);
  const socket = createRelaySocket("a", tauri.listen, tauri.invoke);
  let closed = 0;
  socket.onclose = () => (closed += 1);
  await tick();
  socket.send('{"type":"ping"}');
  assert.deepEqual(tauri.invoked.at(-1), { cmd: "socket_send", args: { instance: "a", frame: '{"type":"ping"}' } });
  socket.close();
  await tick();
  assert.equal(closed, 1);
  assert.equal(tauri.count("socket:open") + tauri.count("socket:message") + tauri.count("socket:closed"), 0);
});
