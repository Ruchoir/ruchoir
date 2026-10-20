# Ruchoir desktop

Ruchoir for Windows, macOS and Linux, built with [Tauri 2](https://tauri.app). The window shows the
web client's interface, embedded in the app, and reaches every instance through the app's own
protocol, where the Rust core adds that instance's session token: the interface never sees one.

- `core/`: the logic that needs no window (instances, tokens, sign-in, proxy rules, realtime). Tested
  on any machine with `cargo test -p ruchoir-desktop-core`.
- `src-tauri/`: the app itself, wiring that logic to the window, the keychain and the deep links.

This directory is its own Cargo workspace, apart from the API's. Building the app needs the system's
webview development files (on Debian or Ubuntu: `libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`,
`librsvg2-dev`, `libsecret-1-dev`). See `docs/desktop.md` for developing, building and trying it.
