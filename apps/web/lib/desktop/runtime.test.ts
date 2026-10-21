import { test } from "node:test";
import assert from "node:assert/strict";

import { desktopOs, instanceBase, isDesktop } from "./runtime.ts";

test("the_web_build_is_not_the_desktop", () => {
  assert.equal(process.env.NEXT_PUBLIC_RUCHOIR_TARGET, undefined);
  assert.equal(isDesktop, false);
});

test("an_instance_lives_under_its_own_path", () => {
  assert.equal(instanceBase("abc123"), "/i/abc123");
});

test("the_system_is_read_from_the_user_agent", () => {
  assert.equal(desktopOs("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"), "windows");
  assert.equal(desktopOs("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)"), "macos");
  assert.equal(desktopOs("Mozilla/5.0 (X11; Linux x86_64)"), "linux");
});
