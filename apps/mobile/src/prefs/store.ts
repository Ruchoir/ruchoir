/**
 * The preferences in force, for every screen, and where they are kept between launches: one small
 * JSON in the secure store, beside the last space chosen (`space/SpaceProvider.tsx`). They are read
 * once before the first screen is drawn (`loadPrefs`), so the app never flashes in the wrong colours
 * or language, and a change is applied at once and written behind.
 */
import * as SecureStore from "expo-secure-store";
import { useSyncExternalStore } from "react";
import { Appearance } from "react-native";

import { applyLocale } from "../i18n";
import { DEFAULT_PREFS, parsePrefs, type Prefs, type ThemeMode } from "./prefs";

const KEY = "ruchoir.prefs";

let current: Prefs = DEFAULT_PREFS;
const listeners = new Set<() => void>();

/**
 * The phone's own controls (date pickers, the keyboard, alerts) follow the app's day or night, not
 * only the screens it draws: a forced mode is handed to the system, "automatic" gives it back.
 */
function applyMode(mode: ThemeMode) {
  Appearance.setColorScheme(mode === "auto" ? "unspecified" : mode === "night" ? "dark" : "light");
}

function apply(prefs: Prefs) {
  applyMode(prefs.mode);
  applyLocale(prefs.locale);
}

/** Read what was chosen, once, before the first screen. */
export async function loadPrefs(): Promise<Prefs> {
  const raw = await SecureStore.getItemAsync(KEY).catch(() => null);
  current = parsePrefs(raw);
  apply(current);
  listeners.forEach((listen) => listen());
  return current;
}

/** Change some preferences: applied at once, kept for the next launch. */
export function setPrefs(patch: Partial<Prefs>) {
  const before = current;
  current = { ...current, ...patch };
  if (patch.mode !== undefined && patch.mode !== before.mode) applyMode(current.mode);
  if (patch.locale !== undefined && patch.locale !== before.locale) applyLocale(current.locale);
  listeners.forEach((listen) => listen());
  void SecureStore.setItemAsync(KEY, JSON.stringify(current)).catch(() => {});
}

function subscribe(listen: () => void) {
  listeners.add(listen);
  return () => {
    listeners.delete(listen);
  };
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribe, () => current);
}
