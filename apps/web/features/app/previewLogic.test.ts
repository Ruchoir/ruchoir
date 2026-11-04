import { test } from "node:test";
import assert from "node:assert/strict";

import { bannerOf, previewToast, viewAsState } from "./previewLogic.ts";

const role = (over: Partial<{ systemKey: "administrator" | "members" | "guests"; manageable: boolean }> = {}) => ({ manageable: true, ...over });

test("the_view_as_button_needs_a_role_below_you", () => {
  const ctx = { edition: "enterprise" as const, canManageRoles: true };
  assert.equal(viewAsState(role(), ctx), "button");
  // At or above the viewer's own role (`manageable` is false), or a base role: no button.
  assert.equal(viewAsState(role({ manageable: false }), ctx), "hidden");
  assert.equal(viewAsState(role({ systemKey: "members" }), ctx), "hidden");
  assert.equal(viewAsState(role({ systemKey: "guests" }), ctx), "hidden");
  // Without the right to manage roles nothing is offered, whatever the role.
  assert.equal(viewAsState(role(), { ...ctx, canManageRoles: false }), "hidden");
  // A free space says it is a paid feature; a frozen one still looks (read only).
  assert.equal(viewAsState(role(), { ...ctx, edition: "community" }), "locked");
  assert.equal(viewAsState(role(), { ...ctx, edition: "frozen" }), "button");
  assert.equal(viewAsState(role({ manageable: false }), { ...ctx, edition: "community" }), "hidden");
});

test("the_banner_names_the_space_and_the_role", () => {
  assert.deepEqual(bannerOf({ roleId: "r", roleName: "Comptable", idleSeconds: 1800 }, "Atelier Dupont"), { space: "Atelier Dupont", role: "Comptable", minutes: 30 });
  // The wire may omit the idle time: thirty minutes, as the server says.
  assert.equal(bannerOf({ roleId: "r", roleName: "Comptable" }, "Atelier").minutes, 30);
  assert.equal(bannerOf({ roleId: "r", roleName: "Comptable", idleSeconds: 600 }, "Atelier").minutes, 10);
});

test("a_refused_write_in_preview_shows_the_toast", () => {
  const toast = previewToast();
  assert.equal(toast.tone, "danger");
  assert.equal(toast.titleKey, "preview.readOnlyTitle");
  assert.equal(toast.bodyKey, "preview.readOnlyBody");
});
