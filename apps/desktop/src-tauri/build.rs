/// Every command of `generate_handler!` (`src/main.rs`). With an app manifest each one needs a
/// permission, granted to the main window only (`capabilities/main.json`): a file window, which
/// shows a file and no interface, can call none of them. Add a command here and in the capability.
const COMMANDS: &[&str] = &[
    "allow_frame_origin",
    "instance_state",
    "instance_add",
    "sign_in_start",
    "sign_in_cancel",
    "instances_state",
    "instance_open",
    "instance_remove",
    "instance_sign_out",
    "summaries",
    "preferences_changed",
    "desktop_settings",
    "set_desktop_settings",
    "set_shell_labels",
    "app_quit",
    "socket_send",
    "socket_is_open",
    "download_save",
    "file_window",
    "download_open",
    "about_app",
    "diagnostics",
    "open_log_folder",
    "update_state",
    "update_install",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("the app's command permissions are generated");
}
