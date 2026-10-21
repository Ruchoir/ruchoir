// End to end check of the desktop app on Linux, driven through `tauri-driver` (WebDriver over HTTP,
// no client library): add an instance, sign in through its `/n/` page and a `ruchoir://` link handed
// to a second launch, see the interface, and see a message posted elsewhere arrive without a reload
// (the realtime relay). Run it through `run.sh`, which provides the display, the session bus and the
// stand-in browser.
//
// Environment: RUCHOIR_DESKTOP_BIN (the built app), E2E_INSTANCE (https origin of a test instance),
// E2E_EMAIL and E2E_PASSWORD (an account there without a second factor), E2E_OTHER_EMAIL (a second
// account with the same password), E2E_SPACE and E2E_CHANNEL (a channel both belong to),
// E2E_OPENED_FILE, and optionally E2E_SCREENSHOT (a PNG of the window at the end). With E2E_INSTANCE_2,
// E2E_EMAIL_2 and E2E_PASSWORD_2 (an account on a second instance), it also adds that instance, signs
// in to it, checks the rail heads both instances' spaces, and opens a space of the first from it. The live message comes from the second account: the interface leaves out its own
// person's messages arriving live, which it has already drawn when sending them.

import { spawn } from "node:child_process";
import { readFileSync, existsSync, writeFileSync } from "node:fs";

const BIN = must("RUCHOIR_DESKTOP_BIN");
const INSTANCE = must("E2E_INSTANCE");
const EMAIL = must("E2E_EMAIL");
const PASSWORD = must("E2E_PASSWORD");
const OPENED = must("E2E_OPENED_FILE");
const OTHER = must("E2E_OTHER_EMAIL");
const SPACE = must("E2E_SPACE");
const CHANNEL = must("E2E_CHANNEL");
const DRIVER = "http://127.0.0.1:4444";
const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";

function must(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function wd(method, path, body) {
  const response = await fetch(`${DRIVER}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${JSON.stringify(json.value)}`);
  return json.value;
}

async function until(what, check, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
}

/** A session on the instance, as a browser would hold it, to play the person's side of `/n/`. */
async function webSession(email = EMAIL, instance = INSTANCE, password = PASSWORD) {
  const response = await fetch(`${instance}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: instance },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`login: ${response.status}`);
  const cookie = response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return (path, init = {}) =>
    fetch(`${instance}/api/v1${path}`, {
      ...init,
      headers: { "content-type": "application/json", origin: instance, cookie, ...(init.headers ?? {}) },
    });
}

async function main() {
  const session = await wd("POST", "/session", {
    capabilities: { alwaysMatch: { "tauri:options": { application: BIN } } },
  });
  const id = session.sessionId;
  const find = (css) => wd("POST", `/session/${id}/element`, { using: "css selector", value: css });
  const run = (script, args = []) => wd("POST", `/session/${id}/execute/sync`, { script, args });

  try {
    // 1. Add the instance.
    const field = await until("the address field", () => find("#dk-address"));
    await wd("POST", `/session/${id}/element/${field[ELEMENT]}/value`, { text: INSTANCE });
    const submit = await find("button[type=submit]");
    await wd("POST", `/session/${id}/element/${submit[ELEMENT]}/click`, {});

    // 2. Start signing in: the app opens the instance's page, which the stand-in browser records.
    await until("the sign-in screen", () =>
      run("return !document.querySelector('#dk-address') && !!document.querySelector('.wc-btn--primary');"),
    );
    await run("document.querySelector('.wc-btn--primary').click();");
    const page = await until("the sign-in page to be opened", () =>
      existsSync(OPENED) ? readFileSync(OPENED, "utf8").trim().split("\n").at(-1) : null,
    );
    const challenge = new URL(page).searchParams.get("c");
    if (!page.startsWith(`${INSTANCE}/n/?c=`) || !/^[0-9a-f]{64}$/.test(challenge ?? "")) {
      throw new Error(`unexpected sign-in page: ${page}`);
    }

    // 3. The person's side: sign in on the page and allow the app, which mints the code.
    const api = await webSession();
    const minted = await api("/auth/native/code", { method: "POST", body: JSON.stringify({ challenge }) });
    const { code } = await minted.json();

    // 4. The page hands the code back on `ruchoir://auth`: a second launch carries it to the first.
    const second = spawn(BIN, [`ruchoir://auth?code=${code}`], { stdio: "ignore" });
    await new Promise((resolve) => second.on("exit", resolve));

    // 5. The interface shows a channel; then open the shared one by its address, as a reload would.
    await until(
      "a channel to open",
      () => run("return /^\\/e\\/[^/]+\\/c\\/[^/]+/.test(location.pathname) ? location.pathname : null;"),
      30000,
    );
    // A path the server hands out as is (an avatar, an icon) reaches the open instance.
    const raw = await wd("POST", `/session/${id}/execute/async`, {
      script: "const d = arguments[arguments.length - 1]; fetch('/api/v1/me/spaces').then((r) => d(r.status), (e) => d(String(e)));",
      args: [],
    });
    if (raw !== 200) throw new Error(`an unprefixed /api/v1 path answered ${raw}`);
    const path = `/e/${SPACE}/c/${CHANNEL}`;
    await run("location.assign(arguments[0]);", [path]);
    await until("the shared channel to open", () => run("return location.pathname === arguments[0];", [path]), 30000);

    // 6. A message posted by someone else arrives without a reload: the relay works.
    const other = await webSession(OTHER);
    const spaces = await (await other("/me/spaces")).json();
    const space = spaces.find((s) => s.slug === SPACE);
    const channels = await (await other(`/spaces/${space.id}/channels`)).json();
    const channel = channels.find((c) => c.name === CHANNEL);
    // Give the reloaded interface its socket before posting.
    await sleep(3000);
    const marker = `desktop end to end ${Date.now()}`;
    const posted = await other(`/conversations/${channel.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ body: marker, attachments: [] }),
    });
    if (!posted.ok) throw new Error(`posting: ${posted.status}`);
    try {
      await until("the message to arrive live", () => run("return document.body.innerText.includes(arguments[0]);", [marker]));
    } catch (error) {
      // What the interface's side of the relay sees, to tell a closed socket from a lost frame.
      const seen = await wd("POST", `/session/${id}/execute/async`, {
        script: `const done = arguments[arguments.length - 1];
          const invoke = window.__TAURI_INTERNALS__.invoke;
          invoke("instance_state").then((view) =>
            invoke("socket_is_open", { instance: view.id }).then(
              (open) => done({ view, open }),
              (e) => done({ view, error: String(e) }),
            ),
            (e) => done({ error: String(e) }),
          );`,
        args: [],
      }).catch((e) => ({ error: e.message }));
      console.error(`relay diagnostics: ${JSON.stringify(seen)}`);
      throw error;
    }

    // 6b. A remount (a notification clicked, here emitted by hand) holds a still of the page until
    // the fresh interface is ready, then lets it go.
    const shot = async (name) => {
      if (!process.env.E2E_SCREENSHOT) return;
      const png = await wd("GET", `/session/${id}/screenshot`);
      writeFileSync(process.env.E2E_SCREENSHOT.replace(/\.png$/, `-${name}.png`), Buffer.from(png, "base64"));
    };
    await shot("before");
    await wd("POST", `/session/${id}/execute/async`, {
      script: `const d = arguments[arguments.length - 1];
        const I = window.__TAURI_INTERNALS__;
        I.invoke("instance_state").then((v) =>
          I.invoke("plugin:event|emit", { event: "desktop:open", payload: { instance: v.id, path: arguments[0] } }).then(() => d(1), (e) => d(String(e))),
        );`,
      args: [path],
    });
    const held = await until("the still to be held", () => run("return !!document.querySelector('.wc-desktop__still--on');"), 3000);
    await shot("during");
    await until("the still to be let go", () => run("return !document.querySelector('.wc-desktop__still--on') && !document.querySelector('.wc-desktop-skeleton');"), 15000);
    await sleep(400);
    await shot("after");
    if (!held) throw new Error("no still during the remount");

    // 7. A second instance (optional): add it, sign in, both headings in the rail, one click back.
    const secondInstance = process.env.E2E_INSTANCE_2;
    if (secondInstance) {
      const invoke = (cmd, args) =>
        wd("POST", `/session/${id}/execute/async`, {
          script: "const d = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]).then((r) => d({ ok: r }), (e) => d({ error: String(e) }));",
          args: [cmd, args],
        });
      const added = await invoke("instance_add", { address: secondInstance });
      if (added.error) throw new Error(`adding ${secondInstance}: ${added.error}`);
      const opened = readFileSync(OPENED, "utf8").trim().split("\n").length;
      await until("the second sign-in screen", () =>
        run("return !!document.querySelector('.wc-btn--primary') && !document.querySelector('.wc-titlebar__search');"),
      );
      await run("document.querySelector('.wc-btn--primary').click();");
      const page2 = await until("the second sign-in page", () => {
        const lines = readFileSync(OPENED, "utf8").trim().split("\n");
        return lines.length > opened ? lines.at(-1) : null;
      });
      const api2 = await webSession(must("E2E_EMAIL_2"), secondInstance, must("E2E_PASSWORD_2"));
      const challenge2 = new URL(page2).searchParams.get("c");
      const { code: code2 } = await (await api2("/auth/native/code", { method: "POST", body: JSON.stringify({ challenge: challenge2 }) })).json();
      const third = spawn(BIN, [`ruchoir://auth?code=${code2}`], { stdio: "ignore" });
      await new Promise((resolve) => third.on("exit", resolve));
      const hosts = [new URL(INSTANCE).host, new URL(secondInstance).host];
      try {
        await until("both instances in the rail", () =>
          run("return arguments[0].every((h) => !!document.querySelector(`[title='${h}']`));", [hosts]),
          30000,
        );
      } catch (error) {
        const titles = await run("return [...document.querySelectorAll('[title]')].map((e) => e.getAttribute('title'));");
        const state = await invoke("instances_state", {});
        console.error(`rail titles: ${JSON.stringify(titles)}; instances: ${JSON.stringify(state)}`);
        throw error;
      }
      // The first instance is now the other one: open its first space from its section.
      const target = await run(
        "const h = document.querySelector(`[title='${arguments[0]}']`); let el = h.nextElementSibling; while (el && !el.querySelector('button')) el = el.nextElementSibling; const b = el && el.querySelector('button'); if (b) b.click(); return !!b;",
        [hosts[0]],
      );
      if (!target) throw new Error("no space of the first instance in the rail");
      // The first instance is the open one again, and its interface is on screen (on one of its spaces).
      await until("the first instance to open", async () => {
        const state = await invoke("instances_state", {});
        const open = state.ok?.find((v) => v.open);
        if (open?.origin !== INSTANCE) return false;
        return run("return location.pathname.startsWith('/e/') && !document.querySelector('.wc-desktop__still--on');");
      }, 30000);
      console.log("ok: second instance added, both in the rail, back on the first by one click");
    }

    // 8. The account menu: "Add an instance" opens the add screen, Cancel comes back; then
    // "Remove this instance" leaves the app at its start, on the add screen when none is left.
    const menu = async () => {
      // The profile button at the bottom of the rail, by its French label.
      await run("const b = document.querySelector(`button[aria-label='${arguments[0]}']`); if (b) b.click();", ["Mon profil et statut"]);
      await sleep(300);
    };
    const clickText = (text) =>
      run("const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === arguments[0]); if (b) b.click(); return !!b;", [text]);
    await menu();
    if (!(await clickText("Ajouter une instance"))) throw new Error("no \"Ajouter une instance\" in the account menu");
    await until("the add screen", () => run("return !!document.querySelector('#dk-address');"));
    if (!(await clickText("Annuler"))) throw new Error("no Cancel on the add screen");
    await until("the interface again, as it was", () =>
      run("return !document.querySelector('#dk-address') && !!document.querySelector(`button[aria-label='${arguments[0]}']`);", ["Mon profil et statut"]),
    );

    if (process.env.E2E_SCREENSHOT) {
      const png = await wd("GET", `/session/${id}/screenshot`);
      writeFileSync(process.env.E2E_SCREENSHOT, Buffer.from(png, "base64"));
    }
    if (!secondInstance) {
      await menu();
      if (!(await clickText("Retirer cette instance"))) throw new Error("no \"Retirer cette instance\" in the account menu");
      try {
        await until("the add screen at the start", () => run("return !!document.querySelector('#dk-address') && location.pathname === '/';"), 30000);
      } catch (error) {
        const state = await run("return { path: location.pathname, add: !!document.querySelector('#dk-address'), text: document.body.innerText.slice(0, 200) };");
        console.error(`after removing: ${JSON.stringify(state)}`);
        throw error;
      }
    }
    console.log(`ok: signed in, ${path} open, live message received, account menu works`);
  } finally {
    await wd("DELETE", `/session/${id}`).catch(() => {});
  }
}

main().catch((error) => {
  console.error(`FAILED: ${error.message}`);
  process.exit(1);
});
