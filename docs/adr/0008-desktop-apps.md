# ADR 0008: Desktop apps with Tauri, one app origin, tokens kept by the core

- Status: accepted
- Date: 2026-10-20

## Context

Ruchoir needs installable apps for Windows, macOS and Linux, all three working at v1. Their interface
is the web client's, with a few desktop details (a title bar of its own, native notifications, files
on the disk). What makes them worth installing over a browser tab: presence in the dock or taskbar,
notifications that need no browser vendor's push service, file integration, and several instances
at once (ADR 0007).

Three constraints shape the choice:

1. Golden rule 2: no US or non-European runtime service, and a European or neutral library where one
   does the job.
2. The person's sessions must stay out of reach of the code a page runs, as on the phone (ADR 0005):
   a token is a key to the account.
3. The app must be light. A chat app stays open all day, beside everything else.

## Decision

**Tauri 2.** Governed by the Tauri Programme within The Commons Conservancy (Netherlands), MIT or
Apache-2.0. It uses the system's own webview (WebView2 on Windows, WKWebView on macOS, WebKitGTK on
Linux) and a Rust core, so an install is about 10 MB. Electron was rejected: its foundation is
American (OpenJS), and it ships a whole Chromium with every app (over 100 MB, and more memory).

**The interface is the web export, embedded.** `apps/web` builds a desktop flavour (`build:desktop`,
`NEXT_PUBLIC_RUCHOIR_TARGET=desktop`) that adds the title bar and the instance screens around the
same `AppRoot`. The web build resolves the desktop entry to an empty module, so none of it reaches a
browser. No remote page is ever loaded in the app window.

**One app origin, a path per instance.** The window loads the app's own protocol,
`ruchoir-app://localhost/` (`http://ruchoir-app.localhost/` on Windows). The Rust core answers it:

- `/i/<instance-id>/api/v1/...` goes to that instance, with its bearer;
- `/emoji/...` goes to a signed-in instance, without one;
- anything else is the embedded interface (`index.html` for a deep path).

One origin rather than one per instance (`ruchoir-api://<id>`, considered first): a cross-origin API
needs CORS, and an SVG `<use href>`, which draws every emoji from the pack's sprite, refuses another
origin outright. The web client runs same-origin with `baseUrl = /i/<id>`; a new client option,
`publicOrigin`, names the instance itself where its real address is needed (a public link copied to
someone, the realtime socket's address).

**The core keeps the tokens; the interface never sees one.** Tokens live in the system keychain
(macOS Keychain, Windows Credential Manager, the Secret Service on Linux, through the `keyring`
crate); a Linux desktop without one keeps them in memory only and says so. No command returns a
token and no event carries one. Upstream, the proxy sends no `Origin` and no cookie and passes no
`Set-Cookie` back, so `token_from_browser` (ADR 0005) is untouched. A 401 (other than a wrong password
typed to confirm an action) or a successful sign-out forgets the token.

**Sign-in through the instance's own page.** The app opens `https://<instance>/n/?c=<challenge>` in
the system browser, as the phone does for passkeys (ADR 0005, step 6f); the page hands back a
single-use code on `ruchoir://auth`, which the core trades with its verifier for a token. One path
for password, codes and passkeys, and no password field in the app. A second launch carrying the
link hands it to the running app (single instance).

**One realtime socket per instance, held by the core.** It carries the bearer and no `Origin`, which
the API accepts from a client that is not a browser. Its frames are relayed to the interface tagged
with the instance; the interface's socket is a relay with a `WebSocket`'s shape, so the shared
client's realtime code is unchanged and there is never a second socket. While the window is
minimised the relay pauses and the interface catches up on return. The same sockets will drive
native notifications and badges for every instance (step 2), without any browser push service.

**Presence:** the app is online on every instance it is connected to (ADR 0007).

**Distribution:** direct download from ruchoir.com, with the Tauri updater against a manifest and
files on Ruchoir's own server, never GitHub's releases (an installed app talks to Ruchoir's server
only). Windows uses an NSIS installer (WiX, behind MSI, is governed by the .NET Foundation, US). No
store in v1. Builds run on GitHub's runners, as the phone's do, on demand or on a `desktop-v*` tag;
they are unsigned until the first release brings a macOS Developer ID and a Windows certificate from
a European authority.

**A Cargo workspace of its own** (`apps/desktop`): the API's checks never need WebKitGTK and Tauri's
tree never touches the API's lockfile. Its logic that needs no window lives in a Tauri-free crate
(`ruchoir-desktop-core`), which is what the pull request check builds and tests.

## Consequences

- The web client has one more build (`build:desktop`), and its screens must keep working with a
  relative `baseUrl` other than empty. Its own person's messages arriving live are still left out, as
  on the web.
- Each system's webview is its own engine: the interface must hold on WebKit (macOS, Linux) as well
  as on Chromium (Windows). Linux's WebKitGTK is the slowest of the three to follow new web features.
- Without a GPU, WebKitGTK's DMA-BUF renderer falls back to software OpenGL, which costs memory and
  processor time at rest. The lightness budget is measured with it off under Xvfb, and by hand on
  real machines at each release.
- Nobody on the team has a Mac: macOS is checked by a volunteer before each release, and launched
  once by each build on GitHub's macOS runner.
- The end to end check needs a Ruchoir instance and runs by hand on the development server, to keep
  the pipeline light.
