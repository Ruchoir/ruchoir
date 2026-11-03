# The desktop app (Windows, macOS, Linux)

`apps/desktop` is Ruchoir for the desktop, built with Tauri 2: the web interface, embedded, in a
frameless window, with a Rust core that holds every instance's session and realtime socket. Why it is
built this way: `docs/adr/0008-desktop-apps.md`.

## How it fits together

```
window ── ruchoir-app://localhost/ ──► Rust core (apps/desktop/src-tauri)
            ├─ /i/<instance-id>/api/v1/…  → that instance, with its bearer (from the keychain)
            ├─ /api/v1/…                  → the open instance (paths the server hands out as they are)
            ├─ /emoji/…                   → a signed-in instance
            └─ anything else              → the embedded web export (apps/web, build:desktop)

core ── per signed-in instance: one realtime socket ──► frames relayed to the open interface
                                  a summary            ──► the rail's other instances, the badge
                                  a notifier           ──► the system's notifications
```

One interface at a time: only the open instance's is mounted; a space of another instance or a click
on a notification mounts a fresh one on that instance (ADR 0008,
amendment of 2026-10-21).

- `apps/desktop/core`: the logic that needs no window (instance list, keychain vault, sign-in
  exchange, proxy rules, realtime watcher, summaries, the notifier's rules). `cargo test -p
  ruchoir-desktop-core` runs anywhere.
- `apps/desktop/src-tauri`: the app (window, protocol, commands, deep links, relay, summaries,
  notifications, tray and badge, launch at login).
- `apps/web/lib/desktop` (bridge to the core, relayed socket, the switch guard) and
  `apps/web/features/desktop` (title bar, add an instance, sign in, the bridge's React context):
  loaded only in the desktop build. The rail, the account menu and the preferences read
  `useDesktop()`, `null` on the web.

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
`RUCHOIR_DESKTOP_DEV_URL` is set. A debug build never checks for updates (it would count in the
anonymous statistics, and an update would replace the binary under test):

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
waits for a message posted by someone else to arrive without a reload. It also sends a 300 KB PDF through the composer's file input and checks the instance stores every byte (uploads once arrived empty), drops a file on the composer with a synthetic event (the page's own drop handling accepts it, it stores the right bytes, and a stray drop is cancelled; the window letting a real drop through is checked by hand), and opens the PDF in the files viewer, checking the page's CSP lets its frame load. Each run leaves two attachments (a PDF and a text file), two messages and the files in "Pièces jointes" in that channel (development data). It needs, on Linux,
`webkit2gtk-driver`, `dbus-x11`, Xvfb and `cargo install tauri-driver --locked`, and an instance with
two accounts sharing a channel:

```bash
RUCHOIR_DESKTOP_BIN=$PWD/target/debug/ruchoir-desktop \
E2E_INSTANCE=https://<dev instance> E2E_EMAIL=alice@atelier.test E2E_OTHER_EMAIL=bob@atelier.test \
E2E_PASSWORD=<seed password> E2E_SPACE=studio-rennes E2E_CHANNEL=general \
e2e/run.sh
```

On Linux the files viewer shows a PDF with WebKitGTK's built-in viewer (checked on WebKitGTK 2.52: page,
zoom, print and save controls, text drawn), so no fallback is needed there. The page cannot read the
viewer's frame (its `contentDocument` is `about:blank`, the built-in viewer is not a page document), which
is why the e2e listens for CSP violations instead. `E2E_SHOTS_DIR=<dir>` makes the run save PNGs of the
PDF viewer and of the channel with its two attachments; `GDK_SCALE=2` gives sharper ones.

Known gap, behind `E2E_OFFICE=1` (off by default, it fails today): opening a .docx in the office editor.
The editor's frame is posted to the engine's `https:` host, but the window's navigation rules
(`leave_for`, `core/src/navigation.rs`) send every `https:` navigation, a frame's included, to the system
browser and refuse it in the window: the frame stays blank and the request never reaches the engine.

It posts a message in that channel each run. The app's own log is kept in
`/tmp/ruchoir-desktop-e2e.log`.

With `E2E_INSTANCE_2`, `E2E_EMAIL_2` and `E2E_PASSWORD_2` (an account on a second instance, which
must offer native sessions, so be a release from October 2026 or later), it also adds that instance,
signs in to it, checks the rail heads both instances' spaces, and opens a space of the first one
from the second. The development host runs one instance; the second is production with Théo's own
account. Native notifications, their click and the badge are checked by hand: WebDriver cannot see
them. So is dropping a file from the system's file manager onto the composer and the files list
(the window must hand the drop to the page, `disable_drag_drop_handler`): WebDriver only sends
synthetic events.

## Trying it on a machine

Install the artifact of the `Desktop apps` workflow, then check, against the development instance:
the frameless window (drag, double click, Windows snap, resizing from the edges), adding the
instance, signing in with a password then a code, and with a passkey, live messages, signing out,
quitting and starting again still signed in, and a second launch bringing the first window forward.
With two instances: both in the rail with their counts, a notification from the one not open and
its click, a notification setting changed on one and found on the other, the badge on the icon and in the tray, closing to the tray and
reopening from it, launch at login (the app starts in the tray), and the memory read in the task
manager.
macOS is checked by a volunteer tester before each release.

## Updates

The app checks `https://ruchoir.com/desktop/latest.json` at launch and every six hours
(`src-tauri/src/updater.rs`). A newer version shows a line under the title bar, "Restart to update":
on the click it is downloaded, its signature checked against the public key in `tauri.conf.json`,
installed, and the app starts again. Windows (NSIS), macOS and the AppImage update themselves; a
`.deb` or `.rpm` install is not updated by the app yet (the updater could, given signed packages in
the manifest, asking for the administrator's password each time), and its button opens the download
page instead. A failed check or
download changes nothing and is tried again at the next check.

The updater's key pair (minisign) is the app's own, apart from the systems' code signing
certificates (which come later). The private key and its password are the repository's secrets
`TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, with a copy in Théo's password
manager. **Losing it means no installed app can ever update again**: every install would have to
be replaced by hand with a build carrying a new public key.

## Logs and diagnostics

The app writes `ruchoir.log` in the system's log folder for it (`tauri-plugin-log`, rotated at 1 MB,
three old files kept): one line per thing worth knowing (start, an update found, a check or a
notification that failed), never what a message says and never a token. Preferences, Application,
"About Ruchoir" shows the version, the system and the web engine, copies the diagnostics (version,
system, installation format, instances counted and named by host, the log's last 200 lines) to the
clipboard, and opens the log folder (`src-tauri/src/diagnostics.rs`). Nothing is sent anywhere by
itself.

## Signing

- **macOS**: a release is signed with the "Developer ID Application" certificate (Théo Vilain,
  team `J6MBDYD9N8`, valid until 2027-12-02) and notarised by Apple with the App Store Connect key
  TestFlight uses (`APPLE_API_KEY_*`). Secrets: `APPLE_CERTIFICATE` (the `.p12`, base64),
  `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`. The release checks the signature,
  Gatekeeper's verdict and the stapled ticket before publishing. The certificate was requested from
  a key made on the development server, never on a Mac; the `.p12` and its password are kept in
  Théo's password manager. Renew it before it expires: a new key and request, the same steps.
- **Every file**: each release has `SHA256SUMS.txt`, signed (`SHA256SUMS.txt.asc`) with Ruchoir's
  release key, `Ruchoir Releases <contact@ruchoir.com>`, fingerprint
  `D868 1A64 9CBE 0E81 1CA1 7BE3 9A78 091C DFC5 D3CB`, valid until 2029-11-01. Its public half is
  `infra/desktop-release/ruchoir-release.asc`, published at
  `https://ruchoir.com/desktop/ruchoir-release.asc`; the private half and its passphrase are the
  secrets `RELEASE_GPG_KEY` and `RELEASE_GPG_PASSPHRASE`, with a copy and the revocation certificate
  in Théo's password manager. To check a download:

  ```bash
  curl -sO https://ruchoir.com/desktop/ruchoir-release.asc && gpg --import ruchoir-release.asc
  gpg --verify SHA256SUMS.txt.asc SHA256SUMS.txt && sha256sum --ignore-missing -c SHA256SUMS.txt
  ```

- **Windows**: SignPath's free signing for open-source projects, applied for on 2026-11-02 (the
  policy it asks for is on ruchoir.com). Until it is set up, the installer is unsigned and
  SmartScreen warns at the first install.

## Usage statistics

Ruchoir counts its desktop apps and their downloads, anonymously (decided 2026-11-01, stated in the
website's legal notice):

- **Active apps.** The first time an app checks for updates it draws a random identifier (128 bits,
  `src-tauri/src/usage.rs`), unrelated to any account, instance or person, and sends it with each
  check (`X-Ruchoir-Install`), with its version (`X-Ruchoir-Version`) and installation format
  (`X-Ruchoir-Format`). Preferences, Application, "Count this installation in the anonymous
  statistics" turns it off: nothing is sent, the identifier is erased, and turning it on again draws
  a new one.
- **Downloads**, by system: a GET answered 200 for an installer under `/desktop/vX.Y.Z/`.

On the website's server both locations log to their own files, whose formats hold no address
(`infra/site-stats/nginx-log-formats.conf`), kept 35 days (`logrotate.conf`). Every night
`ruchoir-stats` (`ruchoir-stats.timer`) writes the totals in `/srv/ruchoir-stats/`: `stats.txt` (the
last day at a glance), `downloads.csv`, `active.csv` (distinct installations the day, the last 7 and
30 days) and `versions.csv`. Only totals outlive the logs.

```bash
ssh ruchoir-site cat /srv/ruchoir-stats/stats.txt
```

Once, by hand, on the website's server: `nginx-log-formats.conf` as
`/etc/nginx/conf.d/ruchoir-stats.conf`, `logrotate.conf` as `/etc/logrotate.d/ruchoir-stats`,
`ruchoir-stats` in `/usr/local/sbin` (root, `0755`), the service and timer in `/etc/systemd/system`
(`systemctl enable --now ruchoir-stats.timer`), and the `access_log` lines of the website
repository's `deploy/nginx/ruchoir.com.conf`.

## Releasing

A tag `desktop-vX.Y.Z` (apart from the instance's `vX.Y.Z` tags) runs the `Desktop apps` workflow
as a release: every system is built with the tag's version and the updater's archives signed, then
the `publish` job gathers the files, writes `latest.json` and a plain download page
(`infra/desktop-release/assemble.mjs`), and hands them to the website's server through the
`deploy` account (secret `DESKTOP_DEPLOY_SSH_KEY`, host and host key shared with the relay's
`RELAY_DEPLOY_HOST` and `RELAY_DEPLOY_KNOWN_HOSTS`). There, `desktop-publish` puts them in
`/srv/ruchoir-desktop/vX.Y.Z/`, then `latest.json` and `index.html` at the top, last, so an app never
reads a manifest naming files not there yet. Older versions stay. Log:
`/var/log/desktop-publish.log`.

Once, by hand, on the website's server:

- `infra/desktop-release/desktop-publish` and `desktop-publish-entry` in `/usr/local/sbin` (root,
  `0755`); a key of its own for the `deploy` account bound to the entry
  (`command="/usr/local/sbin/desktop-publish-entry",restrict ssh-ed25519 … ci-desktop`), and
  `/etc/sudoers.d/desktop-publish`: `deploy ALL=(root) NOPASSWD: /usr/local/sbin/desktop-publish`;
- `/srv/ruchoir-desktop/` (root, `0755`);
- in nginx's `ruchoir.com` server block (the file comes from the website's repository,
  `deploy/nginx/ruchoir.com.conf`: change it there too):

  ```nginx
  location = /desktop/latest.json {
      alias /srv/ruchoir-desktop/latest.json;
      add_header Cache-Control "no-cache" always;
      add_header X-Robots-Tag "noindex" always;
  }
  location /desktop/ {
      alias /srv/ruchoir-desktop/;
      add_header X-Robots-Tag "noindex" always;
  }
  ```

The first version a person installs by hand (from `https://ruchoir.com/desktop/`); each later one
reaches the app by itself. Until the systems' certificates, Windows warns at the first install
(SmartScreen, "More info", "Run anyway") and macOS asks to open it from the Finder's context menu.
