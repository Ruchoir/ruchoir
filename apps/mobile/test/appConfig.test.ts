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

test("the_app_shares_a_keychain_group_with_its_notification_extension", () => {
  // The extension reads the instance and the session token there (ADR 0006).
  assert.deepEqual(appConfig({}).ios?.entitlements?.["keychain-access-groups"], ["$(AppIdentifierPrefix)com.ruchoir.app.shared"]);
});

test("the_build_names_the_apple_team_and_the_firebase_file_only_when_given", () => {
  const built = appConfig({ APPLE_TEAM_ID: "ABCDE12345", GOOGLE_SERVICES_FILE: "/tmp/google-services.json" });
  assert.equal(built.ios?.appleTeamId, "ABCDE12345");
  assert.equal(built.android?.googleServicesFile, "/tmp/google-services.json");
  const bare = appConfig({});
  assert.equal(bare.ios?.appleTeamId, undefined);
  assert.equal(bare.android?.googleServicesFile, undefined);
});

test("notifications_are_signed_for_production", () => {
  const plugin = appConfig({}).plugins?.find((p) => Array.isArray(p) && p[0] === "expo-notifications");
  assert.ok(Array.isArray(plugin));
  assert.equal((plugin[1] as { mode: string }).mode, "production");
});
