// The lightness budget on any of the three systems: start the app with no instance, let it settle,
// then report the memory of the app and its webview processes and the processor time they use over
// 60 idle seconds. `budget.sh` is the Linux check that fails above the limits; this one reports, for
// the Windows and macOS builds, whose runners have no GPU either (so the numbers are an upper bound).
//
// Usage: node e2e/budget-report.mjs <path to the app's binary>
//
// - Windows: the app and its WebView2 processes (`msedgewebview2.exe`, children of the app); memory is
//   their private bytes.
// - macOS: the app and the WebKit processes (`com.apple.WebKit.*`, started by launchd rather than by
//   the app, so taken by name on a runner where nothing else uses WebKit); memory is their resident
//   size, shared pages included.
// - Linux: the app and its children; resident size (budget.sh has the fairer proportional figure).

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = process.argv[2];
if (!bin) {
  console.error("usage: node e2e/budget-report.mjs <app binary>");
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `[dd-][hh:]mm:ss[.ss]`, as `ps` prints processor time, in seconds. */
function psTime(text) {
  const [days, clock] = text.includes("-") ? text.split("-") : ["0", text];
  const parts = clock.split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  const [h, m, s] = parts;
  return Number(days) * 86400 + h * 3600 + m * 60 + s;
}

/** Every process: pid, parent, memory in bytes, processor seconds, name. */
function processes() {
  if (process.platform === "win32") {
    const json = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,PrivatePageCount,KernelModeTime,UserModeTime,Name | ConvertTo-Json -Compress",
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    return JSON.parse(json).map((p) => ({
      pid: p.ProcessId,
      ppid: p.ParentProcessId,
      bytes: Number(p.PrivatePageCount),
      // Kernel and user times are in units of 100 ns.
      cpu: (Number(p.KernelModeTime) + Number(p.UserModeTime)) / 1e7,
      name: p.Name,
    }));
  }
  if (process.platform === "linux") {
    // `ps` gives Linux processor time to the second only: read the ticks from /proc instead.
    const hz = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim()) || 100;
    const list = [];
    for (const line of execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss=,comm="], { encoding: "utf8" }).trim().split("\n")) {
      const [pid, ppid, rss, ...name] = line.trim().split(/\s+/);
      let cpu = 0;
      try {
        const fields = readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /, "").split(" ");
        cpu = (Number(fields[11]) + Number(fields[12])) / hz;
      } catch {
        // The process ended between the two reads.
      }
      list.push({ pid: Number(pid), ppid: Number(ppid), bytes: Number(rss) * 1024, cpu, name: name.join(" ") });
    }
    return list;
  }
  const out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss=,time=,comm="], { encoding: "utf8" });
  return out
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .map(([pid, ppid, rss, time, ...name]) => ({
      pid: Number(pid),
      ppid: Number(ppid),
      bytes: Number(rss) * 1024,
      cpu: psTime(time),
      name: name.join(" "),
    }));
}

/** The app's processes: its tree, plus macOS' WebKit services. */
function ours(all, root) {
  const picked = new Set([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of all) {
      if (!picked.has(p.pid) && picked.has(p.ppid)) {
        picked.add(p.pid);
        grew = true;
      }
    }
  }
  return all.filter(
    (p) => picked.has(p.pid) || (process.platform === "darwin" && p.name.includes("com.apple.WebKit")),
  );
}

const total = (list, key) => list.reduce((sum, p) => sum + p[key], 0);

async function main() {
  // A fresh data directory, so no instance from an earlier run is found.
  const data = mkdtempSync(join(tmpdir(), "ruchoir-budget-"));
  const env = { ...process.env, XDG_DATA_HOME: data, APPDATA: data, LOCALAPPDATA: data };
  const app = spawn(bin, [], { env, stdio: "ignore" });
  try {
    await sleep(15000);
    const first = ours(processes(), app.pid);
    if (!first.some((p) => p.pid === app.pid)) throw new Error("the app is not running");
    const memoryMb = Math.round(total(first, "bytes") / 1048576);
    const cpuBefore = total(first, "cpu");
    await sleep(60000);
    const cpuAfter = total(ours(processes(), app.pid), "cpu");
    const idle = (((cpuAfter - cpuBefore) / 60) * 100).toFixed(2);
    const names = [...new Set(first.map((p) => p.name.split(/[\\/]/).pop()))].join(", ");
    console.log(`${process.platform}: memory ${memoryMb} MB, processor over 60 s idle ${idle} % (${names})`);
  } finally {
    app.kill();
  }
}

main().catch((error) => {
  console.error(`budget report failed: ${error.message}`);
  process.exit(1);
});
