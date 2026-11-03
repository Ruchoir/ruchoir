#!/usr/bin/env node
/**
 * Style fingerprint of the main screens: the computed shadows, transforms, edges, radii, spacings
 * and colours of every element, one JSON file per (theme, width, state). Taken before and after a
 * change that must not move a pixel, then compared with `compare.mjs`. See README.md.
 *
 *   node tools/style-fingerprint/run.mjs --url <base> --out <dir> [--themes sky,sky-dark] [--width 1440,390]
 *     [--style <name>] [--png] [--only <state>,<state>]
 *
 * A theme is `<accent>`, `<accent>-dark`, or `<accent>-auto` (automatic mode on a dark device).
 * `--style` seeds a simplified style (see the design system's "Simplified styles"); `--png` also
 * writes `<state>.png` beside each JSON file, at twice the pixel density, for a person to look at;
 * `--only` keeps the named states.
 *
 * Signs in through the login form with RUCHOIR_FP_EMAIL (default alice@atelier.test, a seeded
 * account of the dev database) and RUCHOIR_SEED_PASSWORD, then walks the screens of the seeded space
 * (STEPS).
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

/** The space every state is taken in: the seed's, with channels, messages, files and events. */
const SPACE = "studio-rennes";

/**
 * The screens, reached the way a person reaches them (the dev deep link renders an empty shell
 * without the API, so it cannot show a real feed). Each starts from the space's general channel.
 * Labels are the English ones: the seeded accounts use English. A step whose target is not on
 * screen (the compact layout hides some) is skipped and logged, on both runs alike.
 */
const role = (name) => (p) => p.getByRole("button", { name, exact: true }).locator("visible=true").first().click({ timeout: 4000 });
const text = (name) => (p) => p.getByText(name, { exact: true }).locator("visible=true").first().click({ timeout: 4000 });
// The rail's own button, found by its label (its tooltip names it otherwise to the accessibility tree).
const me = (p) => p.locator('button[aria-label="My profile and status"]').locator("visible=true").first().click({ timeout: 4000 });
// A row's actions button takes the pointer only while the row is hovered: hover, then click where it is.
async function openChannelMenu(p) {
  await p.locator(".wc-side-item", { hasText: "annonces" }).first().hover({ timeout: 4000 });
  await p.waitForTimeout(300);
  const box = await p.locator('button[aria-label="Actions for annonces"]').first().boundingBox();
  if (!box) throw new Error("no actions button");
  await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await p.locator('[role="menu"]').first().waitFor({ timeout: 4000 });
}
const STEPS = [
  { id: "channel", act: null },
  { id: "channel@hover-side-item", act: (p) => p.hover(".wc-side-item", { timeout: 4000 }), keep: true },
  { id: "channel@menu", act: openChannelMenu, keep: true },
  { id: "channel@focus-composer", act: (p) => p.locator(".wc-message-composer [contenteditable], .wc-message-composer textarea").first().focus({ timeout: 4000 }), keep: true },
  { id: "channel-members", act: role("Members") },
  { id: "channel-files", act: role("Files") },
  { id: "dm", act: text("Yanis Berthier") },
  { id: "dm@hover-reaction", act: async (p) => { await text("Yanis Berthier")(p); await p.locator(".wc-react").locator("visible=true").first().hover({ timeout: 4000 }); } },
  { id: "files", act: text("Space files") },
  { id: "calendar", act: text("Calendar") },
  { id: "threads", act: text("Threads") },
  { id: "mentions", act: text("Mentions") },
  { id: "saved", act: text("Saved") },
  { id: "settings", act: text("Space settings") },
  { id: "prefs", act: async (p) => { await me(p); await text("Preferences")(p); } },
  { id: "user-menu", act: me },
  { id: "modal-search", act: (p) => p.keyboard.press("Control+K") },
  { id: "modal-newChannel", act: role("New channel") },
  { id: "modal-newChannel@hover-primary", act: async (p) => { await role("New channel")(p); await p.locator(".wc-btn--primary").locator("visible=true").first().hover({ timeout: 4000 }); } },
];

/** The properties a style may change, read on every element. */
const PROPS = [
  "box-shadow",
  "transform",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-bottom-right-radius",
  "border-bottom-left-radius",
  "outline-color",
  "outline-width",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "gap",
  "background-color",
  "color",
  "font-family",
  "width",
  "height",
];

// No motion, and no badge of the dev server: it sits over the rail's own button and in the screenshots.
const NO_MOTION = "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}nextjs-portal{display:none!important}";

function parseArgs(argv) {
  const args = { url: "", out: "", themes: ["sky", "sky-dark"], widths: [1440, 390], style: null, png: false, only: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") args.url = argv[++i].replace(/\/$/, "");
    else if (a === "--out") args.out = path.resolve(argv[++i]);
    else if (a === "--themes") args.themes = argv[++i].split(",");
    else if (a === "--width") args.widths = argv[++i].split(",").map(Number);
    else if (a === "--style") args.style = argv[++i];
    else if (a === "--png") args.png = true;
    else if (a === "--only") args.only = argv[++i].split(",");
  }
  if (!args.url || !args.out) {
    console.error("usage: run.mjs --url <base> --out <dir> [--themes sky,sky-dark] [--width 1440,390]");
    process.exit(2);
  }
  return args;
}

/** Runs in the page: every element's path and computed properties. */
function collect(props) {
  const segment = (el) => {
    const classes = [...el.classList].filter((c) => c.startsWith("wc-")).sort();
    const index = el.parentElement ? [...el.parentElement.children].indexOf(el) : 0;
    return `${el.tagName.toLowerCase()}${classes.map((c) => `.${c}`).join("")}:${index}`;
  };
  const out = [];
  for (const el of document.body.querySelectorAll("*")) {
    if (el.closest("svg") && el.tagName.toLowerCase() !== "svg") continue;
    if (el.tagName === "SCRIPT" || el.tagName === "STYLE") continue;
    const parts = [];
    for (let n = el; n && n !== document.body; n = n.parentElement) parts.unshift(segment(n));
    const cs = getComputedStyle(el);
    const values = {};
    for (const p of props) values[p] = cs.getPropertyValue(p);
    out.push({ path: parts.join(" > "), props: values });
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const password = process.env.RUCHOIR_SEED_PASSWORD;
  if (!password) {
    console.error("RUCHOIR_SEED_PASSWORD is not set (the seed password of apps/api/src/seed.rs).");
    process.exit(2);
  }
  const email = process.env.RUCHOIR_FP_EMAIL || "alice@atelier.test";
  const browser = await chromium.launch();
  const steps = args.only ? STEPS.filter((s) => args.only.includes(s.id)) : STEPS;
  for (const theme of args.themes) {
    const [accent, suffix] = theme.split("-");
    const mode = suffix === "auto" ? "auto" : suffix ? "night" : "day";
    const seeded = { accent, mode, ...(args.style ? { style: args.style } : {}) };
    // Automatic mode is taken on a dark device, so it shows the night it resolves to.
    const device = { colorScheme: suffix === "auto" ? "dark" : "light", deviceScaleFactor: args.png ? 2 : 1 };
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...device });
    await context.addInitScript(
      (seed) => {
        const k = "ruchoir.settings";
        const s = JSON.parse(localStorage.getItem(k) || "{}");
        localStorage.setItem(k, JSON.stringify({ ...s, ...seed }));
      },
      seeded,
    );
    const page = await context.newPage();

    // Sign in once per context; the session cookie carries the rest.
    await page.goto(`${args.url}/?stage=login`, { waitUntil: "networkidle" });
    const user = page.locator('input[autocomplete="username"]');
    if (await user.count()) {
      await user.fill(email);
      await page.fill('input[autocomplete="current-password"]', password);
      await page.click('button[type="submit"]');
      await page.waitForSelector(".wc-side-item", { timeout: 30000 });
    }

    for (const width of args.widths) {
      const dir = path.join(args.out, theme, String(width));
      await mkdir(dir, { recursive: true });
      await page.setViewportSize({ width, height: 900 });
      const capture = async (id) => {
        // Long enough for a dialog or a popover to have opened and its data to have arrived.
        await page.waitForTimeout(1000);
        const data = await page.evaluate(collect, PROPS);
        await writeFile(path.join(dir, `${id}.json`), JSON.stringify(data, null, 1));
        if (args.png) await page.screenshot({ path: path.join(dir, `${id}.png`) });
        console.log(`${theme} ${width} ${id}: ${data.length} elements`);
      };
      // The login screen, signed out, in a context of its own.
      const out = await browser.newContext({ viewport: { width, height: 900 }, ...device });
      await out.addInitScript((seed) => localStorage.setItem("ruchoir.settings", JSON.stringify(seed)), seeded);
      const lp = await out.newPage();
      await lp.goto(`${args.url}/?stage=login`, { waitUntil: "networkidle" });
      await lp.addStyleTag({ content: NO_MOTION });
      await lp.waitForTimeout(300);
      const loginData = await lp.evaluate(collect, PROPS);
      await writeFile(path.join(dir, "login.json"), JSON.stringify(loginData, null, 1));
      if (args.png) await lp.screenshot({ path: path.join(dir, "login.png") });
      console.log(`${theme} ${width} login: ${loginData.length} elements`);
      await out.close();

      for (const step of steps) {
        if (!step.keep || step.id === "channel") {
          await page.goto(`${args.url}/e/${SPACE}/c/general`, { waitUntil: "networkidle" });
          await page.waitForSelector("[data-mid]", { timeout: 15000 }).catch(() => {});
          await page.addStyleTag({ content: NO_MOTION });
        }
        if (step.act) {
          const ok = await step.act(page).then(() => true, () => false);
          if (!ok) {
            console.log(`${theme} ${width} ${step.id}: target not on screen, skipped`);
            continue;
          }
          await page.waitForLoadState("networkidle").catch(() => {});
        }
        await capture(step.id);
        if (step.keep) await page.mouse.move(0, 0);
      }
    }
    await context.close();
  }
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
