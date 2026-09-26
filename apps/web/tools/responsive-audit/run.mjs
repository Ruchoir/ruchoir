#!/usr/bin/env node
/**
 * Responsive stress test for the Ruchoir web client.
 *
 * Sweeps every UI state (tools/responsive-audit/states.mjs) across a wide matrix of viewports
 * (viewports.mjs), runs an in-page probe (probe.mjs) at each combination, screenshots the
 * suspect ones, and writes a JSON + HTML report (report.mjs). Exits non-zero when a critical
 * issue (horizontal page overflow or a JS error) is found, so it can gate CI.
 *
 * The app has no URL routes, so states are reached through the dev deep-link
 * (lib/dev/deeplink.ts): run the dev server first, then point this at it.
 *
 *   pnpm --dir apps/web dev            # terminal 1
 *   pnpm --dir apps/web audit:responsive   # terminal 2
 *
 * Flags:
 *   --url <url>       base URL (default http://localhost:3000)
 *   --out <dir>       output dir (default tools/responsive-audit/report)
 *   --tag <t,...>     keep only viewports carrying every tag (e.g. quick, zoom, mobile-portrait)
 *   --state <id,...>  keep only these states (e.g. files,login)
 *   --themes <t,...>  sweep these themes (sky,mint,violet,pink and each with -dark); default sky only
 *   --all-themes      shorthand for every shipped theme
 *   --fail-rules <r,...>  exit non-zero if any finding matches these rules (e.g. low-contrast,icon-contrast)
 *   --quick           shorthand for --tag quick (a fast, representative subset)
 *   --reload          reload the page for each viewport instead of resizing in place (slower, stricter)
 *   --headed          show the browser window
 */

import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildViewports, filterViewports } from "./viewports.mjs";
import { STATES, filterStates } from "./states.mjs";
import { PROBE } from "./probe.mjs";
import { writeReports } from "./report.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const ACCENTS = ["sky", "mint", "violet", "pink"];
const ALL_THEMES = [...ACCENTS, ...ACCENTS.map((a) => `${a}-dark`)];

/** Where the dev server is, from --url, else $AUDIT_URL, else $PORT on localhost, else the default. */
function defaultUrl() {
  if (process.env.AUDIT_URL) return process.env.AUDIT_URL;
  if (process.env.PORT) return `http://localhost:${process.env.PORT}`;
  return "http://localhost:3000";
}

function parseArgs(argv) {
  const args = { url: defaultUrl(), out: path.join(HERE, "report"), tags: [], states: [], themes: [], failRules: [], reload: false, headed: false, failOn: "critical" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") args.url = argv[++i];
    else if (a === "--out") args.out = path.resolve(argv[++i]);
    else if (a === "--tag") args.tags.push(...argv[++i].split(","));
    else if (a === "--state") args.states.push(...argv[++i].split(","));
    else if (a === "--theme" || a === "--themes") args.themes.push(...argv[++i].split(","));
    else if (a === "--all-themes") args.themes.push(...ALL_THEMES);
    else if (a === "--fail-rules") args.failRules.push(...argv[++i].split(",")); // fail if any finding matches these rules, regardless of severity
    else if (a === "--quick") args.tags.push("quick");
    else if (a === "--reload") args.reload = true;
    else if (a === "--headed") args.headed = true;
    else if (a === "--fail-on") args.failOn = argv[++i]; // critical (default) | major | none
  }
  // Default to the base theme only, so the existing responsive job is unaffected.
  if (args.themes.length === 0) args.themes = ["sky"];
  else args.themes = [...new Set(args.themes)];
  return args;
}

const CLS_INIT = `
  window.__wcCls = 0;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) { if (!e.hadRecentInput) window.__wcCls += e.value; }
    }).observe({ type: "layout-shift", buffered: true });
  } catch (e) {}
`;

/** Collect width breakpoints declared in the page's stylesheets (Tailwind + custom CSS). */
async function discoverBreakpoints(page) {
  return page.evaluate(() => {
    const px = new Set();
    const re = /(?:min|max)-width:\s*(\d+(?:\.\d+)?)px/g;
    for (const sheet of document.styleSheets) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue; // cross-origin sheet, skip
      }
      const walk = (list) => {
        for (const rule of list) {
          if (rule.media && rule.conditionText) {
            let m;
            while ((m = re.exec(rule.conditionText))) px.add(Math.round(parseFloat(m[1])));
          }
          if (rule.cssRules) walk(rule.cssRules);
        }
      };
      walk(rules);
    }
    return [...px].sort((a, b) => a - b);
  });
}

function sanitize(s) {
  return s.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    console.error(
      "\nPlaywright is not installed. This is a dev-only QA dependency.\n" +
        "  pnpm --dir apps/web add -D playwright\n" +
        "  pnpm --dir apps/web exec playwright install chromium\n"
    );
    process.exit(2);
  }

  const states = filterStates(STATES, args.states);
  const outDir = args.out;
  const shotsDir = path.join(outDir, "shots");
  await rm(outDir, { recursive: true, force: true });
  await mkdir(shotsDir, { recursive: true });

  const browser = await chromium.launch({ headless: !args.headed });
  const context = await browser.newContext();
  await context.addInitScript(CLS_INIT);
  const page = await context.newPage();

  // Per-run error capture.
  let consoleErrors = [];
  let pageErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 300));
  });
  page.on("pageerror", (err) => pageErrors.push(String(err.message || err).slice(0, 300)));

  // Reach the app once to discover breakpoints and build the viewport matrix.
  const probeUrl = (query) => `${args.url.replace(/\/$/, "")}/?${query}`;
  await page.setViewportSize({ width: 1440, height: 900 });
  try {
    await page.goto(probeUrl("stage=app&view=channel&channel=general"), { waitUntil: "networkidle", timeout: 30000 });
  } catch (e) {
    console.error(`\nCannot reach ${args.url}. Start the dev server first: pnpm --dir apps/web dev\n(${e.message})`);
    await browser.close();
    process.exit(2);
  }
  const breakpoints = await discoverBreakpoints(page);
  const viewports = filterViewports(buildViewports(breakpoints), args.tags);

  console.log(
    `Audit: ${states.length} states x ${viewports.length} viewports = ${states.length * viewports.length} combinations` +
      (breakpoints.length ? ` (breakpoints: ${breakpoints.join(", ")})` : " (no width breakpoints found)")
  );

  const runs = [];
  let done = 0;
  const multiTheme = args.themes.length > 1;
  const total = args.themes.length * states.length * viewports.length;

  // Persist the theme the way the app itself does (the `theme` setting in localStorage), so the
  // SettingsProvider applies it authoritatively on the next load. Setting data-theme directly is not
  // enough: the provider's mount effect re-asserts the stored theme after hydration and would clobber
  // a bare attribute set, silently probing the wrong theme.
  const seedTheme = (theme) =>
    page.evaluate((t) => {
      try {
        const k = "ruchoir.settings";
        const s = JSON.parse(localStorage.getItem(k) || "{}");
        s.theme = t;
        localStorage.setItem(k, JSON.stringify(s));
      } catch {}
      document.documentElement.dataset.theme = t;
    }, theme);

  for (const theme of args.themes) {
    // Seed on the currently-loaded page; localStorage persists across the same-origin navigations
    // below, so every subsequent goto boots into this theme.
    await seedTheme(theme);
    for (const state of states) {
      if (!args.reload) {
        consoleErrors = [];
        pageErrors = [];
        await page.goto(probeUrl(state.query), { waitUntil: "networkidle", timeout: 30000 });
        if (state.waitFor) await page.waitForSelector(state.waitFor, { timeout: 5000 }).catch(() => {});
        await seedTheme(theme);
      }
      for (const vp of viewports) {
        if (args.reload) {
          consoleErrors = [];
          pageErrors = [];
        }
        await page.setViewportSize({ width: vp.width, height: vp.height });
        if (args.reload) {
          await page.goto(probeUrl(state.query), { waitUntil: "networkidle", timeout: 30000 });
          if (state.waitFor) await page.waitForSelector(state.waitFor, { timeout: 5000 }).catch(() => {});
        }
        await seedTheme(theme); // re-assert after any (re)navigation, so every probe sees this theme
        await page.waitForTimeout(140); // let layout settle after the resize
        await page.evaluate(() => (window.__wcCls = 0));
        await page.waitForTimeout(60);

        const runConsole = consoleErrors.slice();
        const runPage = pageErrors.slice();
        const { findings, meta } = await page.evaluate(PROBE, { isTouch: vp.touch });

        let screenshot = null;
        if (findings.length > 0 || runPage.length > 0) {
          const file = `${sanitize(theme)}__${sanitize(state.id)}__${sanitize(vp.label)}.png`;
          await page.screenshot({ path: path.join(shotsDir, file) });
          screenshot = path.join("shots", file);
        }

        runs.push({
          theme,
          // Fold the theme into the reported id/label so the report groups by theme without schema changes.
          stateId: multiTheme ? `${theme}__${state.id}` : state.id,
          stateLabel: multiTheme ? `[${theme}] ${state.label}` : state.label,
          viewport: { label: vp.label, width: vp.width, height: vp.height, group: vp.group },
          findings,
          probeMeta: meta,
          consoleErrors: runConsole,
          pageErrors: runPage,
          screenshot,
        });
        done++;
      }
      process.stdout.write(`  ${multiTheme ? theme + "/" : ""}${state.id}: done (${done}/${total})\n`);
    }
  }

  await browser.close();

  const meta = {
    generatedAt: new Date().toISOString(),
    url: args.url,
    themes: args.themes,
    stateCount: states.length,
    viewportCount: viewports.length,
    reloaded: args.reload,
  };
  const summary = await writeReports(outDir, meta, runs);

  console.log("\nSummary");
  console.log(`  themes: ${args.themes.join(", ")}`);
  console.log(`  critical ${summary.bySeverity.critical}   major ${summary.bySeverity.major}   minor ${summary.bySeverity.minor}`);
  console.log(`  JS errors ${summary.pageErrors}   console errors ${summary.consoleErrors}   max CLS ${summary.worstCls}`);
  for (const [rule, n] of Object.entries(summary.byRule).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${rule.padEnd(20)} ${n}`);
  }
  console.log(`\nReport: ${path.join(outDir, "report.html")}`);

  // Count findings matching the --fail-rules set (rule-based gate, independent of severity).
  const ruleHits = args.failRules.length
    ? runs.reduce((n, r) => n + r.findings.filter((f) => args.failRules.includes(f.rule)).length, 0)
    : 0;

  let failed = false;
  if (args.failOn === "critical") failed = summary.bySeverity.critical > 0 || summary.pageErrors > 0;
  else if (args.failOn === "major") failed = summary.bySeverity.critical + summary.bySeverity.major > 0 || summary.pageErrors > 0;
  if (args.failRules.length && ruleHits > 0) {
    failed = true;
    console.log(`\n${ruleHits} finding(s) matching --fail-rules ${args.failRules.join(",")}`);
  }
  if (failed) console.log(`\nFAIL (--fail-on ${args.failOn}${args.failRules.length ? ` --fail-rules ${args.failRules.join(",")}` : ""})`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
