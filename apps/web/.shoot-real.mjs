import { chromium } from "playwright";
import fs from "node:fs";
const H = "https://ruchoir-dev.theovilain.fr";
const shots = JSON.parse(process.argv[2]);
const cookies = JSON.parse(fs.readFileSync("/tmp/shots/cookies.json")).map((c) => ({ name: c.name, value: c.value, url: H + "/", secure: true, httpOnly: c.httpOnly, sameSite: "Lax" }));
const browser = await chromium.launch();
for (const [name, theme, w, h, act] of shots) {
  const phoneish = (w || 1440) < 1200;
  const ctx = await browser.newContext({ viewport: { width: w || 1440, height: h || 900 }, hasTouch: phoneish, isMobile: (w || 1440) < 800 });
  await ctx.addCookies(cookies);
  await ctx.addInitScript((t) => localStorage.setItem("ruchoir.settings", JSON.stringify({ theme: t, welcome: { dismissed: true, done: [] }, notifPrompted: true })), theme || "sky");
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(name, "pageerror", e.message));
  await page.goto(H + "/", { waitUntil: "networkidle" }).catch((e) => console.log(name, e.message));
  await page.waitForTimeout(2000);
  const longPress = async (locator) => {
    const box = await locator.boundingBox();
    const cdp = await ctx.newCDPSession(page);
    const pt = { x: box.x + box.width / 2, y: box.y + Math.min(20, box.height / 2) };
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [pt] });
    await page.waitForTimeout(700);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  if (act) { try { await eval(`(async () => { ${act} })()`); } catch (e) { console.log(name, "act", e.message); } await page.waitForTimeout(1200); }
  await page.screenshot({ path: `/tmp/shots/${name}.png` });
  await ctx.close();
}
await browser.close();
