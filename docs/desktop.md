# The desktop app (Windows, macOS, Linux)

`apps/desktop` is Ruchoir for the desktop, built with Tauri 2: the web interface, embedded, in a
frameless window, with a Rust core that holds every instance's session and realtime socket. Why it is
built this way: `docs/adr/0008-desktop-apps.md`.

## How it fits together

```
window ── ruchoir-app://localhost/ ──► Rust core (apps/desktop/src-tauri)
            ├─ /i/<instance-id>/api/v1/…  → that instance, with its bearer (from the keychain)
            ├─ /emoji/…                   → a signed-in instance
            └─ anything else              → the embedded web export (apps/web, build:desktop)

core ── one realtime socket per instance ──► frames relayed to the interface as events
```

- `apps/desktop/core`: the logic that needs no window (instance list, keychain vault, sign-in
  exchange, proxy rules, realtime watcher). `cargo test -p ruchoir-desktop-core` runs anywhere.
- `apps/desktop/src-tauri`: the app (window, protocol, commands, deep links, relay).
- `apps/web/lib/desktop` (bridge to the core, relayed socket) and `apps/web/features/desktop`
  (title bar, add an instance, sign in): loaded only in the desktop build.

## Building

The system's webview development files are needed on Linux (Debian, Ubuntu):

```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev \
  libsecret-1-dev xdg-utils desktop-file-utils
```

Windows needs nothing beyond Rust and Node (WebView2 is part of Windows 10 and 11; the installer
brings it where missing). macOS needs the Xcode command line tools.

```bash
pnpm install
cd apps/desktop
pnpm tauri build                 # installers for this system, in target/release/bundle/
pnpm tauri build --no-bundle     # the app alone, target/release/ruchoir-desktop
```

`pnpm tauri build` builds the interface first (`pnpm --filter @ruchoir/web build:desktop`, into
`apps/web/out`). The CI does the same for the three systems: the `Desktop apps` workflow, started by
its button, by the label `desktop-build` on a pull request, or by a `desktop-v*` tag. Its artifacts
(an NSIS installer, a `.dmg` and `.app`, an AppImage with `.deb` and `.rpm`) are kept a week. They are
unsigned until the first release: Windows' SmartScreen and macOS' Gatekeeper warn before opening them
(on macOS, right click, Open).

## Developing

A debug build reads the interface from the embedded export, or from a running `next dev` when
`RUCHOIR_DESKTOP_DEV_URL` is set:

```bash
pnpm --filter @ruchoir/web dev:desktop          # next dev on port 3112, desktop flavour
cd apps/desktop && RUCHOIR_DESKTOP_DEV_URL=http://localhost:3112 cargo run
```

Next's hot reload cannot follow the app's own origin: restart the app to see a change.

An instance address must be `https://`. The development instance (`ruchoir-dev`) works as is; its
seeded accounts (`alice@atelier.test`, password in `apps/api/src/seed.rs`) have no second factor.

## Checks

On every pull request that touches `apps/desktop`, the CI runs the core's format, clippy and tests
(no WebKitGTK needed). Before a pull request is merged, run the rest by hand:

```bash
cd apps/desktop
cargo clippy --all-targets -- -D warnings
pnpm tauri build --no-bundle
RUCHOIR_DESKTOP_BIN=$PWD/target/release/ruchoir-desktop e2e/budget.sh
```

### The lightness budget

`e2e/budget.sh` starts the release build with no instance, window shown, and fails above 250 MB of
proportional memory (the app and its WebKit processes) or 1 % processor over 60 idle seconds. Under
Xvfb it turns WebKit's DMA-BUF renderer off: without a GPU it falls back to software OpenGL, which no
desktop with a graphics card pays. Measured on 2026-10-20: 237 MB, 0.95 %. On real machines, read
the memory in the task manager at each release.

`e2e/budget-report.mjs` measures the same on Windows (the app and its WebView2 processes, private
bytes) and macOS (the app and the WebKit services, resident size), and only reports: the `Desktop
apps` workflow runs it after the Windows and macOS builds and writes the figures in the run's
summary. Its runners have no GPU either, so the figures are an upper bound.

### The end to end check

`e2e/run.sh` drives the app through `tauri-driver` (WebDriver): it adds an instance, signs in through
the instance's `/n/` page and a `ruchoir://auth` link handed to a second launch, opens a channel, and
waits for a message posted by someone else to arrive without a reload. It needs, on Linux,
`webkit2gtk-driver`, `dbus-x11`, Xvfb and `cargo install tauri-driver --locked`, and an instance with
two accounts sharing a channel:

```bash
RUCHOIR_DESKTOP_BIN=$PWD/target/debug/ruchoir-desktop \
E2E_INSTANCE=https://<dev instance> E2E_EMAIL=alice@atelier.test E2E_OTHER_EMAIL=bob@atelier.test \
E2E_PASSWORD=<seed password> E2E_SPACE=studio-rennes E2E_CHANNEL=general \
e2e/run.sh
```

It posts a message in that channel each run. The app's own log is kept in
`/tmp/ruchoir-desktop-e2e.log`.

## Trying it on a machine

Install the artifact of the `Desktop apps` workflow, then check, against the development instance:
the frameless window (drag, double click, Windows snap, resizing from the edges), adding the
instance, signing in with a password then a code, and with a passkey, live messages, signing out,
quitting and starting again still signed in, and a second launch bringing the first window forward.
macOS is checked by a volunteer tester before each release.
