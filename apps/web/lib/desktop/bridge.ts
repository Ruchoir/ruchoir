/**
 * The interface's side of the desktop app's core: typed wrappers around its commands and events.
 *
 * Nothing here ever carries a session token: the core keeps them (ADR 0008). Command errors are short
 * codes (`not_https`, `unreachable`, `outdated`...) the screens translate.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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
};

export const instanceState = () => invoke<InstanceView>("instance_state");
export const instanceAdd = (address: string) => invoke<InstanceView>("instance_add", { address });
export const signInStart = () => invoke<void>("sign_in_start");
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
