// End to end check of the desktop app on Linux, driven through `tauri-driver` (WebDriver over HTTP,
// no client library): add an instance, sign in through its `/n/` page and a `ruchoir://` link handed
// to a second launch, see the interface, and see a message posted elsewhere arrive without a reload
// (the realtime relay). Run it through `run.sh`, which provides the display, the session bus and the
// stand-in browser.
//
// Environment: RUCHOIR_DESKTOP_BIN (the built app), E2E_INSTANCE (https origin of a test instance),
// E2E_EMAIL and E2E_PASSWORD (an account there without a second factor), E2E_OTHER_EMAIL (a second
// account with the same password), E2E_SPACE and E2E_CHANNEL (a channel both belong to),
// E2E_OPENED_FILE. The live message comes from the second account: the interface leaves out its own
// person's messages arriving live, which it has already drawn when sending them.

import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

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
async function webSession(email = EMAIL) {
  const response = await fetch(`${INSTANCE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: INSTANCE },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!response.ok) throw new Error(`login: ${response.status}`);
  const cookie = response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return (path, init = {}) =>
    fetch(`${INSTANCE}/api/v1${path}`, {
      ...init,
      headers: { "content-type": "application/json", origin: INSTANCE, cookie, ...(init.headers ?? {}) },
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

    console.log(`ok: signed in, ${path} open, live message received`);
  } finally {
    await wd("DELETE", `/session/${id}`).catch(() => {});
  }
}

main().catch((error) => {
  console.error(`FAILED: ${error.message}`);
  process.exit(1);
});
