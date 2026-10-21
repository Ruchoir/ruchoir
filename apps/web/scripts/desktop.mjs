// Runs `next build` or `next dev` for the desktop app (`NEXT_PUBLIC_RUCHOIR_TARGET=desktop`). A script
// rather than `VAR=value next ...` in package.json, which Windows' shell does not understand, and the
// desktop app is built on Windows too.
//
// Usage: node scripts/desktop.mjs build | dev
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const mode = process.argv[2];
if (mode !== "build" && mode !== "dev") {
  console.error("usage: node scripts/desktop.mjs build | dev");
  process.exit(2);
}
const next = createRequire(import.meta.url).resolve("next/dist/bin/next");
const args = mode === "dev" ? ["dev", "-p", "3112"] : ["build"];
const child = spawn(process.execPath, [next, ...args], {
  stdio: "inherit",
  env: { ...process.env, NEXT_PUBLIC_RUCHOIR_TARGET: "desktop" },
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
