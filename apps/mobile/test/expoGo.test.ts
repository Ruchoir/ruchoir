import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Native modules Expo Go does not carry throw as soon as they are loaded, which takes the whole app
 * down at launch there (it happened with expo-notifications). They are reached only through the
 * file that loads them on demand, where the module exists.
 */
const GUARDED: Record<string, string> = {
  "expo-notifications": "src/push/native.ts",
  "expo-task-manager": "src/push/native.ts",
  "react-native-android-widget": "src/widgets/android.tsx",
  "react-native-document-scanner-plugin": "src/native/documentScanner.ts",
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

test("modules_expo_go_lacks_are_never_imported_at_the_top_of_a_file", () => {
  const offenders: string[] = [];
  for (const path of [...files("src"), "index.ts"]) {
    const source = readFileSync(path, "utf8");
    for (const [module, home] of Object.entries(GUARDED)) {
      if (path === home) continue;
      // A type-only import vanishes from the bundle; anything else loads the module.
      const loads = new RegExp(`^import (?!type )[^;]*from "${module}"`, "m");
      if (loads.test(source)) offenders.push(`${path} loads ${module}`);
    }
  }
  assert.deepEqual(offenders, []);
});
