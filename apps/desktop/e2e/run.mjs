// End to end check of the desktop app on Linux, driven through `tauri-driver` (WebDriver over HTTP,
// no client library): add an instance, sign in through its `/n/` page and a `ruchoir://` link handed
// to a second launch, see the interface, and see a message posted elsewhere arrive without a reload
// (the realtime relay). Run it through `run.sh`, which provides the display, the session bus and the
// stand-in browser.
//
// Environment: RUCHOIR_DESKTOP_BIN (the built app), E2E_INSTANCE (https origin of a test instance),
// E2E_EMAIL and E2E_PASSWORD (an account there without a second factor), E2E_OTHER_EMAIL (a second
// account with the same password), E2E_SPACE and E2E_CHANNEL (a channel both belong to),
// E2E_OPENED_FILE, and optionally E2E_SHOTS_DIR (PNGs for people to read) and E2E_SCREENSHOT (a PNG of the window at the end). With E2E_INSTANCE_2,
// E2E_EMAIL_2 and E2E_PASSWORD_2 (an account on a second instance), it also adds that instance,
// signs in to it, checks the rail heads both instances' spaces, and opens a space of the first from
// it. The live message comes from the second account: the interface leaves out its own person's
// messages arriving live, which it has already drawn when sending them.

import { spawn } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { crc32 } from "node:zlib";
import { basename, join } from "node:path";

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
      // A multipart body carries its own content type (with the boundary).
      headers: { ...(init.body instanceof FormData ? {} : { "content-type": "application/json" }), origin: instance, cookie, ...(init.headers ?? {}) },
    });
}

/**
 * A valid one-page PDF of exactly `size` bytes that draws a line of text, so a screenshot of the
 * viewer shows something. The padding is a comment after the trailer.
 */
function fixturePdf(size) {
  const text = "Ruchoir, essai d'envoi depuis l'application";
  const stream = `BT /F1 11 Tf 12 100 Td (${text.replace(/[()\\]/g, "")}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const padding = size - out.length;
  // Printable bytes only, so the file stays text a tool can read; the length is what the check needs.
  out += `%${"x".repeat(padding - 2)}\n`;
  return Buffer.from(out, "latin1");
}

/** A minimal valid .docx (a zip, stored without compression: Node has no zip writer to lean on). */
function fixtureDocx() {
  const files = {
    "[Content_Types].xml":
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "_rels/.rels":
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml":
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Ruchoir, un document de test pour l\'éditeur (${Date.now()}).</w:t></w:r></w:p></w:body></w:document>`,
  };
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(text);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

async function main() {
  const session = await wd("POST", "/session", {
    capabilities: { alwaysMatch: { "tauri:options": { application: BIN } } },
  });
  const id = session.sessionId;
  const find = (css) => wd("POST", `/session/${id}/element`, { using: "css selector", value: css });
  // The generated PDF, removed whether the run passes or not.
  let fixturePath = null;
  let docxPath = null;
  // Screenshots for people to read, only when E2E_SHOTS_DIR is set (a normal run writes nothing).
  const frameShot = async (name) => {
    const dir = process.env.E2E_SHOTS_DIR;
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    const png = await wd("GET", `/session/${id}/screenshot`);
    writeFileSync(join(dir, `${name}.png`), Buffer.from(png, "base64"));
  };
  const run = (script, args = []) => wd("POST", `/session/${id}/execute/sync`, { script, args });
  const clickText = (text) =>
    run("const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === arguments[0]); if (b) b.click(); return !!b;", [text]);
  // A file added to the composer is settled once its chip stops saying it is uploading; the
  // interface's own refusal ("Fichier non envoyé") is the failure this check exists to catch.
  const settled = (name) =>
    until(`${name} to be uploaded from the composer`, async () => {
      const state = await run(
        `const text = document.body.innerText;
         if (text.includes('Fichier non envoyé')) return 'refused';
         const composer = document.querySelector('.wc-message-composer').innerText;
         return composer.includes(arguments[0]) && !composer.includes('envoi…') ? 'ready' : null;`,
        [name],
      );
      if (state === "refused") throw new Error(`the interface refused ${name} ("Fichier non envoyé")`);
      return state === "ready";
    });
  const clickAria = (label) =>
    until(`the "${label}" button`, () =>
      run("const b = document.querySelector(`button[aria-label='${arguments[0]}']:not([disabled])`); if (!b) return false; b.click(); return true;", [label]),
    );

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
    // The first-steps card would sit over the screenshots; dismiss it through the interface.
    await sleep(1500);
    await clickText("Ne plus afficher");

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

    // 6c. Files, through the real interface: a picked file reaches the instance whole (the core's
    // upload once arrived empty), a drop reaches the page (the webview's own drag-drop handler used
    // to take it), and the viewer's frame is admitted by the page's CSP.
    fixturePath = join(tmpdir(), `ruchoir-e2e-${Date.now()}.pdf`);
    const fixture = fixturePdf(300 * 1024);
    writeFileSync(fixturePath, fixture);
    const pickedName = basename(fixturePath);
    const inputs = await find(".wc-message-composer input[type=file]");
    // The input is hidden (the paperclip button opens it); WebDriver is still given the path.
    await wd("POST", `/session/${id}/element/${inputs[ELEMENT]}/value`, { text: fixturePath });
    await settled(pickedName);
    await clickAria("Envoyer");
    await until("the attachment card", () => run("return document.body.innerText.includes(arguments[0]);", [pickedName]));
    // What the instance holds, read with the account's own session: the size must be the fixture's.
    const stored = await until("the file on the instance", async () => {
      const files = await (await api(`/conversations/${channel.id}/files`)).json();
      return files.find((f) => f.name === pickedName);
    });
    if (stored.size_bytes !== fixture.length) {
      throw new Error(`the instance holds ${stored.size_bytes} bytes of ${pickedName}, expected ${fixture.length}`);
    }
    console.log(`ok: picked file stored whole (${stored.size_bytes} bytes)`);

    // A drop on the composer, as the page sees one. This is a synthetic event: it goes through the
    // page's own drop handling only, never Tauri's native handler, so it proves the page accepts a
    // dropped file, not that the window lets a real drop through (a manual check, docs/desktop.md).
    const droppedName = `dropped-${Date.now()}.txt`;
    const droppedText = "dropped on the composer";
    await run(
      `const composer = document.querySelector('.wc-message-composer');
       const data = new DataTransfer();
       data.items.add(new File([arguments[1]], arguments[0], { type: 'text/plain' }));
       for (const type of ['dragenter', 'dragover', 'drop']) {
         composer.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
       }`,
      [droppedName, droppedText],
    );
    await settled(droppedName);
    await clickAria("Envoyer");
    await until("the second attachment card", () => run("return document.body.innerText.includes(arguments[0]);", [droppedName]));
    const droppedStored = await until("the dropped file on the instance", async () => {
      const files = await (await api(`/conversations/${channel.id}/files`)).json();
      return files.find((f) => f.name === droppedName);
    });
    if (droppedStored.size_bytes !== Buffer.byteLength(droppedText)) {
      throw new Error(`the instance holds ${droppedStored.size_bytes} bytes of ${droppedName}, expected ${Buffer.byteLength(droppedText)}`);
    }
    // A file dropped outside any drop zone must not navigate the window to it.
    const before = await run("return location.href;");
    await run(
      `const data = new DataTransfer();
       data.items.add(new File(['stray'], 'stray.txt', { type: 'text/plain' }));
       window.__strayPrevented = false;
       document.body.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
       const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data });
       document.body.dispatchEvent(drop);
       window.__strayPrevented = drop.defaultPrevented;`,
    );
    if (!(await run("return window.__strayPrevented;")) || (await run("return location.href;")) !== before) {
      throw new Error("a file dropped outside any drop zone was not cancelled");
    }

    // The viewer: the space's files, the PDF opened, its frame in the page.
    const sideItem = await run(
      `const el = [...document.querySelectorAll('span, div')].find((x) => x.children.length === 0 && x.textContent.trim() === arguments[0]);
       if (el) el.click();
       return !!el;`,
      ["Fichiers de l'espace"],
    );
    if (!sideItem) throw new Error("no \"Fichiers de l'espace\" in the sidebar");
    // Attachments live in folders of their own; "Récents" lists the file whatever its folder.
    await until("the files screen", () => run("const el = [...document.querySelectorAll('span, div, button')].find((x) => x.children.length === 0 && x.textContent.trim() === arguments[0]); if (el) el.click(); return !!el;", ["Pièces jointes"]));
    // A frame the page's CSP refuses leaves no error to read (its document is blank either way), so
    // the refusal itself is listened for.
    await run("window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));");
    const opened = await until("the PDF in the files list", () =>
      run(
        "const b = document.querySelector(`button[title='${arguments[0]}']`); if (!b) return false; b.click(); return true;",
        [pickedName],
      ),
    );
    if (!opened) throw new Error("the PDF could not be opened");
    const frame = await until("the viewer's frame", () =>
      run("const f = document.querySelector('.wc-viewer iframe'); return f ? { src: f.src } : null;"),
    );
    // The page cannot read the frame (WebKitGTK's built-in PDF viewer is not a page document: its
    // contentDocument reads about:blank), so the check is that the page raised no CSP violation.
    await sleep(1500);
    const refused = await run("return window.__csp;");
    if (refused.length > 0) throw new Error(`the page's CSP refused the viewer's frame: ${JSON.stringify(refused)}`);
    await frameShot("viewer-pdf");
    // An open menu owns Escape: one press closes the menu and leaves the viewer under it open.
    await until("the viewer's open button", () => run("const b = document.querySelector('.wc-viewer [aria-haspopup=menu]'); if (!b) return false; b.click(); return true;"));
    await until("the viewer's open menu", () => run("return !!document.querySelector('[role=menu]');"));
    await wd("POST", `/session/${id}/actions`, {
      actions: [{ type: "key", id: "keyboard", actions: [{ type: "keyDown", value: "\uE00C" }, { type: "keyUp", value: "\uE00C" }] }],
    });
    await until("the menu to close", () => run("return !document.querySelector('[role=menu]');"), 5000);
    if (!(await run("return !!document.querySelector('.wc-viewer');"))) throw new Error("Escape closed the viewer along with the menu");
    console.log(`ok: dropped file attached, viewer frame shown (${JSON.stringify(frame)})`);

    {
      // The office editor: the engine's host is a frame of the interface, which the window must let load
      // (WebKit hands a frame's navigation to the window's rules), and which must not go to the browser.
      // The office side: a .docx put in the files list, then opened in the editor, whose toolbar must appear in the engine's frame.
      await run("document.querySelector('.wc-viewer button[aria-label=\"Fermer\"]')?.click();");
      await until("the viewer to close", () => run("return !document.querySelector('.wc-viewer');"));
      docxPath = join(tmpdir(), `ruchoir-e2e-${Date.now()}.docx`);
      writeFileSync(docxPath, fixtureDocx());
      const docxName = basename(docxPath);
      // The files screen's own upload input, not the composer's (the screen is open here).
      await run("const i = [...document.querySelectorAll('input[type=file]')].find((x) => x.multiple && !x.closest('.wc-message-composer')); if (i) i.setAttribute('data-e2e-upload', '1'); return !!i;");
      const uploadInput = await find("input[data-e2e-upload]");
      await wd("POST", `/session/${id}/element/${uploadInput[ELEMENT]}/value`, { text: docxPath });
      // The list is sorted by name and long on a development instance: "Récents" puts it on top.
      await sleep(3000);
      await run("const el = [...document.querySelectorAll('button, [role=tab]')].find((x) => x.textContent.trim() === 'Récents'); if (el) el.click(); return !!el;");
      const docRow = () =>
        run("return [...document.querySelectorAll('body *')].filter((x) => x.textContent.trim() === arguments[0]).length > 0;", [docxName]);
      await until("the .docx in the files list", docRow, 30000);
      // With the office engine on, opening a .docx goes straight to the editor (the converted viewer is
      // only the fallback when the engine is down), as the row's first menu entry says.
      await run("window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));");
      await clickAria(`Actions pour ${docxName}`);
      await until("the editor entry", () => run("const el = [...document.querySelectorAll('[role=menuitem], button')].find((x) => x.textContent.trim() === arguments[0]); if (el) el.click(); return !!el;", ["Ouvrir dans l'éditeur"]), 5000);
      const editorFrame = await until("the editor's frame", () => run("return !!document.querySelector('.wc-office iframe');"), 30000);
      // The frame is the engine's origin, over https, and shown once its page says it is painted.
      const editorSrc = await until("the editor's page to be revealed", () =>
        run("const f = document.querySelector('.wc-office iframe'); return f && !f.className.includes('--hidden') && !document.querySelector('.wc-office__cover') ? f.name : null;"),
        30000,
      );
      console.log(`ok: .docx opened in the editor (${editorFrame}, frame ${editorSrc}), painted (the page left its cover)`);
      await frameShot("editor-docx");
      if (readFileSync(OPENED, "utf8").includes("office")) throw new Error("the editor's address was handed to the system browser");
      await run("document.querySelector('.wc-office button[aria-label=\"Fermer\"]')?.click();");
      await until("the editor to close", () => run("return !document.querySelector('.wc-office');"), 20000);
    }
    await run("location.assign(arguments[0]);", [path]);
    await until("the channel again", () => run("return location.pathname === arguments[0] && !!document.querySelector('.wc-message-composer');", [path]), 30000);
    await sleep(1500);
    await frameShot("channel-two-attachments");

    // 6d. The attachment's "open" entries: a window of its own (one per address), and the computer's app.
    const handles = async () => (await wd("GET", `/session/${id}/window/handles`)).length;
    const menuItem = (testId) =>
      until(`the "${testId}" entry`, () =>
        run("const el = document.querySelector(`[role=menuitem][data-testid='${arguments[0]}']`); if (el) el.click(); return !!el;", [testId]),
      );
    const windowsBefore = await handles();
    await clickAria(`Ouvrir ${pickedName}`);
    await until("the open menu", () => run("return !!document.querySelector('[role=menu]');"));
    await sleep(300);
    await frameShot("open-menu");
    await menuItem("open-window");
    await until("a window of its own", async () => (await handles()) === windowsBefore + 1);
    // The same address again brings the window forward instead of opening a second one.
    await clickAria(`Ouvrir ${pickedName}`);
    await menuItem("open-window");
    await sleep(1500);
    if ((await handles()) !== windowsBefore + 1) throw new Error("a second click opened a second window");
    // Its screenshot, then back to the main window.
    const all6 = await wd("GET", `/session/${id}/window/handles`);
    const mainHandle = await wd("GET", `/session/${id}/window`);
    const fileHandle = all6.find((h) => h !== mainHandle);
    await wd("POST", `/session/${id}/window`, { handle: fileHandle });
    await sleep(1500);
    // The window shows the file's preview address on the app's own origin.
    const windowUrl = await wd("GET", `/session/${id}/url`);
    if (!/\/files\/[^/]+\/preview$/.test(windowUrl) || !/^(ruchoir-app:\/\/localhost|http:\/\/ruchoir-app\.localhost)\//.test(windowUrl)) {
      throw new Error(`the file window shows ${windowUrl}, expected the file's preview on the app origin`);
    }
    await frameShot("file-window");
    await wd("POST", `/session/${id}/window`, { handle: mainHandle });
    console.log("ok: attachment opens in a window of its own, once");
    // The computer's app: the stand-in opener records the path the core handed it.
    const linesBefore = existsSync(OPENED) ? readFileSync(OPENED, "utf8").trim().split("\n").length : 0;
    await clickAria(`Ouvrir ${pickedName}`);
    await menuItem("open-local");
    const recorded = await until("the opener to be called", () => {
      if (!existsSync(OPENED)) return null;
      const lines = readFileSync(OPENED, "utf8").trim().split("\n");
      return lines.length > linesBefore ? lines.at(-1) : null;
    });
    if (!recorded.includes(pickedName)) throw new Error(`the opener was given ${recorded}, expected the file ${pickedName}`);
    console.log(`ok: attachment opened with the computer's app (${recorded})`);

    // A file carrying a script, opened in a window, must not run it: the window is a page of the
    // app's own origin, where a script would reach the app's commands.
    const hostile = [
      ["html", "<!doctype html><title>safe</title><script>document.title='pwned'</script><p>hello</p>", "text/html"],
      ["svg", "<?xml version='1.0' encoding='UTF-8'?><svg xmlns='http://www.w3.org/2000/svg' width='40' height='40'><script>document.title='pwned';document.documentElement.setAttribute('data-ran','1')</script><rect width='40' height='40' fill='teal'/></svg>", "image/svg+xml"],
    ];
    for (const [ext, content, type] of hostile) {
      const name = `script-${Date.now()}.${ext}`;
      const form = new FormData();
      form.append("file", new Blob([content], { type }), name);
      form.append("name", name);
      const sent = await api(`/spaces/${space.id}/files`, { method: "POST", body: form });
      if (!sent.ok) throw new Error(`could not upload ${name}: ${sent.status}`);
      const stored = await sent.json();
      const fileId = stored.id ?? stored.file?.id;
      if (!fileId) throw new Error(`no id for ${name}: ${JSON.stringify(stored)}`);
      // The preview address, on the same instance prefix as the PDF viewer's frame above.
      const href = frame.src.replace(/\/files\/.*$/, `/files/${fileId}/preview`);
      const served = await api(`/files/${fileId}/preview`);
      // The instance must serve it inline (the server sniffs the bytes: an SVG without an XML prolog
      // is stored as an octet stream and offered as a download, which would make this check vacuous).
      if (!(served.headers.get("content-disposition") ?? "").startsWith("inline")) {
        throw new Error(`the ${ext} file is not served inline (${served.headers.get("content-type")}): the check would prove nothing`);
      }
      const known = await wd("GET", `/session/${id}/window/handles`);
      const before = known.length;
      const result = await wd("POST", `/session/${id}/execute/async`, {
        script: "const d = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke('file_window', { href: arguments[0], title: arguments[1] }).then(() => d('ok'), (e) => d(String(e)));",
        args: [href, name],
      });
      if (result !== "ok") throw new Error(`the ${ext} file did not open in a window: ${result}`);
      await until(`the ${ext} window`, async () => (await handles()) === before + 1);
      await sleep(1500);
      const now = await wd("GET", `/session/${id}/window/handles`);
      await wd("POST", `/session/${id}/window`, { handle: now.find((h) => !known.includes(h)) });
      const title = await wd("GET", `/session/${id}/title`);
      // Positive controls, so the check cannot pass on a blank or failed page: the window shows this
      // file's preview on the app's origin, and its document did load.
      const windowUrl = await wd("GET", `/session/${id}/url`);
      // WebKitGTK reports no address for a standalone SVG document: its root element is the control there.
      if (ext === "html" && windowUrl !== href) throw new Error(`the ${ext} window shows ${windowUrl}, expected ${href}`);
      const probe = await run("return { root: document.documentElement.localName, ran: document.documentElement.getAttribute('data-ran'), title: document.title, image: (() => { const i = document.querySelector('img'); return !!i && i.naturalWidth > 0; })() };");
      await wd("POST", `/session/${id}/window`, { handle: mainHandle });
      if (title.includes("pwned") || probe.title.includes("pwned") || probe.ran !== null) {
        throw new Error(`the script of the ${ext} file ran in its window (${JSON.stringify(probe)})`);
      }
      if (ext === "html" && title !== "safe") throw new Error(`the html window did not render its document (title "${title}")`);
      // WebKitGTK wraps a standalone SVG in an image page (an <img>, where no script runs at all);
      // WebView2 and WKWebView load it as an SVG document, where the policy is what stops it.
      if (ext === "svg" && probe.root !== "svg" && !probe.image) throw new Error(`the svg window did not load its image (${JSON.stringify(probe)})`);
      console.log(`ok: the ${ext} file's script did not run in its window (title "${title}", root "${probe.root}")`);
    }

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
    if (fixturePath) rmSync(fixturePath, { force: true });
    if (docxPath) rmSync(docxPath, { force: true });
    await wd("DELETE", `/session/${id}`).catch(() => {});
  }
}

main().catch((error) => {
  console.error(`FAILED: ${error.message}`);
  process.exit(1);
});
