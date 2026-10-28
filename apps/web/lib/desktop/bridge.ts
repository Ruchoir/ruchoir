/**
 * The interface's side of the desktop app's core: typed wrappers around its commands and events.
 *
 * Nothing here ever carries a session token: the core keeps them (ADR 0008). Command errors are short
 * codes (`not_https`, `unreachable`, `outdated`...) the screens translate.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { DesktopSettings, Summary } from "./instances";
import type { Invoke, Listen } from "./relaySocket";

export type InstanceState = "none" | "signed_out" | "signing_in" | "signed_in";

/** The instance the interface shows, as the core reports it. */
export type InstanceView = {
  id: string | null;
  origin: string | null;
  name: string | null;
  state: InstanceState;
  /** False on a Linux desktop without a keychain: the session ends when the app quits. */
  vault_persistent: boolean;
  /** The instance the interface shows. */
  open: boolean;
};

export const instanceState = () => invoke<InstanceView>("instance_state");
export const instanceAdd = (address: string) => invoke<InstanceView>("instance_add", { address });
/** Open an instance's sign-in page in the browser (the open instance when none is named). */
export const signInStart = (id?: string) => invoke<void>("sign_in_start", { id: id ?? null });
export const instancesState = () => invoke<InstanceView[]>("instances_state");
export const instanceOpen = (id: string) => invoke<void>("instance_open", { id });
export const instanceRemove = (id: string) => invoke<void>("instance_remove", { id });
export const instanceSignOut = (id: string) => invoke<void>("instance_sign_out", { id });
export const summaries = () => invoke<Record<string, Summary>>("summaries");
/** The open instance's notification settings were saved: the core reads them again. */
export const preferencesChanged = (id: string) => invoke<void>("preferences_changed", { id });
export const desktopSettings = () => invoke<DesktopSettings>("desktop_settings");
/** End the app (the window's close only hides it to the tray). */
export const quitApp = () => invoke<void>("app_quit");
/** "Save as" for a download link of the interface; false when the person cancelled. */
export const downloadSave = (href: string, name: string) => invoke<boolean>("download_save", { href, name });
/** Open what a link points at in the system's app for it (the calendar's PDF, to print). */
export const downloadOpen = (href: string, name: string) => invoke<void>("download_open", { href, name });
export const setDesktopSettings = (settings: DesktopSettings) => invoke<DesktopSettings>("set_desktop_settings", { settings });
/** The tray menu's words and the first-close notice, in the interface's language. */
export const setShellLabels = (labels: { open: string; quit: string; closed_to_tray: string }) =>
  invoke<void>("set_shell_labels", { labels });

/** Follow every instance. */
export function onInstancesChanged(handler: (views: InstanceView[]) => void): Promise<() => void> {
  return listen<InstanceView[]>("instances:changed", (event) => handler(event.payload));
}

/** Hear an instance's summary change. */
export function onSummaryChanged(handler: (instance: string, summary: Summary) => void): Promise<() => void> {
  return listen<{ instance: string; summary: Summary }>("summary:changed", (event) =>
    handler(event.payload.instance, event.payload.summary),
  );
}

/** A notification was clicked: the core opened its instance; the interface goes to `path`. */
export function onDesktopOpen(handler: (instance: string, path: string) => void): Promise<() => void> {
  return listen<{ instance: string; path: string }>("desktop:open", (event) =>
    handler(event.payload.instance, event.payload.path),
  );
}
export const signInCancel = () => invoke<void>("sign_in_cancel");

/** Follow the instance's state. Resolves to the function that stops following. */
export function onInstanceChanged(handler: (view: InstanceView) => void): Promise<() => void> {
  return listen<InstanceView>("instance:changed", (event) => handler(event.payload));
}

/** Hear of a sign-in the instance refused (an expired page, a code already used). */
export function onSignInFailed(handler: (reason: string) => void): Promise<() => void> {
  return listen<string>("sign-in:failed", (event) => handler(event.payload));
}

/** Tauri's own `listen` and `invoke`, in the shape the relay socket takes. */
export const tauriListen: Listen = (event, handler) => listen(event, (e) => handler(e.payload));
export const tauriInvoke: Invoke = (cmd, args) => invoke(cmd, args);
