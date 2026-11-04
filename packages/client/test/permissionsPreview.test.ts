// Run with `pnpm --filter @ruchoir/client test` (Node's own runner, types stripped by Node).
import { test } from "node:test";
import assert from "node:assert/strict";

import { bannerOf, shouldShowToast, previewGone, previewToast, shouldToastRefusal, viewAsState } from "../src/permissionsLogic/preview.ts";

const role = (over: Partial<{ systemKey: "administrator" | "members" | "guests"; manageable: boolean }> = {}) => ({ manageable: true, ...over });

test("the_view_as_button_needs_a_role_below_you", () => {
  const ctx = { edition: "enterprise" as const, canManageRoles: true };
  assert.equal(viewAsState(role(), ctx), "button");
  // At or above the viewer's own role (`manageable` is false), or a base role: no button.
  assert.equal(viewAsState(role({ manageable: false }), ctx), "hidden");
  assert.equal(viewAsState(role({ systemKey: "members" }), ctx), "hidden");
  assert.equal(viewAsState(role({ systemKey: "guests" }), ctx), "hidden");
  // The Administrator role is refused by the API too (a base role).
  assert.equal(viewAsState(role({ systemKey: "administrator" }), ctx), "hidden");
  // Without the right to manage roles nothing is offered, whatever the role.
  assert.equal(viewAsState(role(), { ...ctx, canManageRoles: false }), "hidden");
  // A free space says it is a paid feature; a frozen one still looks (read only).
  assert.equal(viewAsState(role(), { ...ctx, edition: "community" }), "locked");
  assert.equal(viewAsState(role(), { ...ctx, edition: "frozen" }), "button");
  assert.equal(viewAsState(role({ manageable: false }), { ...ctx, edition: "community" }), "hidden");
});

test("the_banner_names_the_space_and_the_role", () => {
  assert.deepEqual(bannerOf({ roleId: "c6f204bc-8cc0-55a4-b2e2-799dcda9120e", roleName: "Comptable", idleSeconds: 1800 }, "Atelier Dupont"), { space: "Atelier Dupont", role: "Comptable", minutes: 30 });
  // The wire may omit the idle time: thirty minutes, as the server says.
  assert.equal(bannerOf({ roleId: "c6f204bc-8cc0-55a4-b2e2-799dcda9120e", roleName: "Comptable" }, "Atelier").minutes, 30);
  assert.equal(bannerOf({ roleId: "c6f204bc-8cc0-55a4-b2e2-799dcda9120e", roleName: "Comptable", idleSeconds: 600 }, "Atelier").minutes, 10);
});

test("a_refused_write_in_preview_shows_the_toast", () => {
  const toast = previewToast();
  assert.equal(toast.tone, "danger");
  assert.equal(toast.titleKey, "preview.readOnlyTitle");
  assert.equal(toast.bodyKey, "preview.readOnlyBody");
});

test("a_preview_gone_on_the_server_ends_the_banner", () => {
  const space = "5f0c8b9a-1d2e-4f3a-9b4c-6d7e8f9a0b1c";
  const other = "6a1d9cab-2e3f-4a4b-8c5d-7e8f9a0b1c2d";
  const role = "7b2eadbc-3f40-4b5c-9d6e-8f9a0b1c2d3e";
  // Still previewing as the same role: nothing to do.
  assert.equal(previewGone(role, [{ id: space, preview: { roleId: role } }], space), false);
  // The server ended it (30 minutes without activity): the screen reloads as the person.
  assert.equal(previewGone(role, [{ id: space }], space), true);
  // Another role is previewed now (started elsewhere): also a different view.
  assert.equal(previewGone(role, [{ id: space, preview: { roleId: other } }], space), true);
  // Not previewing here, or the space is no longer listed (the answer is no proof): nothing to do.
  assert.equal(previewGone(undefined, [{ id: space }], space), false);
  assert.equal(previewGone(role, [], space), false);
});

test("a_second_toast_is_skipped_for_a_preview_refusal", () => {
  assert.equal(shouldToastRefusal({ code: "preview_read_only" }), false);
  assert.equal(shouldToastRefusal({ code: "cannot_grant" }), true);
  assert.equal(shouldToastRefusal(undefined), true);
});

test("a_failure_toast_never_hides_the_preview_refusal", () => {
  const refusedAt = 10_000;
  const failure = { tone: "danger" as const, isPreviewToast: false };
  // Right after a preview refusal, the screen's own "not sent" toast stays quiet.
  assert.equal(shouldShowToast(refusedAt, 10_400, failure), false);
  // The preview toast itself, a success, an info, and a failure long after, all show.
  assert.equal(shouldShowToast(refusedAt, 10_400, { tone: "danger", isPreviewToast: true }), true);
  assert.equal(shouldShowToast(refusedAt, 10_400, { tone: "success", isPreviewToast: false }), true);
  // The composer says "Message non envoye" as an info toast: it is a failure all the same.
  assert.equal(shouldShowToast(refusedAt, 10_400, { tone: "info", isPreviewToast: false }), false);
  assert.equal(shouldShowToast(refusedAt, 13_000, failure), true);
  // No refusal yet: everything shows.
  assert.equal(shouldShowToast(undefined, 10_400, failure), true);
});

test("the_preview_toast_names_the_refused_action", () => {
  // A message sent to a channel or a thread: the frame's sentence about the message.
  assert.equal(previewToast({ method: "POST", path: "/channels/c1/messages" }).bodyKey, "preview.readOnlyBodySend");
  assert.equal(previewToast({ method: "POST", path: "/dms/d1/messages" }).bodyKey, "preview.readOnlyBodySend");
  // Any other write, or no request known: the generic sentence.
  assert.equal(previewToast({ method: "PUT", path: "/channels/c1/messages/m1" }).bodyKey, "preview.readOnlyBody");
  assert.equal(previewToast({ method: "POST", path: "/spaces/s1/roles" }).bodyKey, "preview.readOnlyBody");
  assert.equal(previewToast().bodyKey, "preview.readOnlyBody");
  assert.equal(previewToast({ method: "POST", path: "/channels/c1/messages" }).titleKey, "preview.readOnlyTitle");
});
