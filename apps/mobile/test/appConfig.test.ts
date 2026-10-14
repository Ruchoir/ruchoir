import { test } from "node:test";
import assert from "node:assert/strict";

import { appConfig } from "../app.config.ts";

test("the_build_number_comes_from_the_workflow", () => {
  const config = appConfig({ RUCHOIR_BUILD_NUMBER: "42" });
  assert.equal(config.ios?.buildNumber, "42");
  assert.equal(config.android?.versionCode, 42);
});

test("without_a_build_number_none_is_set", () => {
  const config = appConfig({});
  assert.equal(config.ios?.buildNumber, undefined);
  assert.equal(config.android?.versionCode, undefined);
});

test("a_malformed_build_number_is_refused", () => {
  for (const wrong of ["4.2", "abc", "0", "-3", " 7"]) {
    assert.throws(() => appConfig({ RUCHOIR_BUILD_NUMBER: wrong }), /RUCHOIR_BUILD_NUMBER/);
  }
});

test("the_app_declares_no_custom_encryption", () => {
  // HTTPS and the system's cryptography only: App Store Connect then skips the export question.
  assert.equal(appConfig({}).ios?.config?.usesNonExemptEncryption, false);
});
