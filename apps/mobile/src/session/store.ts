/**
 * What the app keeps between launches: the instance it talks to and the session token.
 *
 * Both live in the Keychain (Android: the Keystore), readable only while the phone is unlocked and
 * never copied into a backup or to another device (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`). Beside them the
 * app keeps only what names nothing sensitive (the last space opened, the preferences of `prefs/`)
 * and downloaded files, in a cache emptied at sign-out. A password typed at sign-up is never written.
 */
import * as SecureStore from "expo-secure-store";

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};
const TOKEN = "ruchoir.session";
const SERVER = "ruchoir.server";

export const store = {
  getToken: () => SecureStore.getItemAsync(TOKEN, OPTIONS),
  setToken: (token: string) => SecureStore.setItemAsync(TOKEN, token, OPTIONS),
  clearToken: () => SecureStore.deleteItemAsync(TOKEN, OPTIONS),
  getServer: () => SecureStore.getItemAsync(SERVER, OPTIONS),
  setServer: (origin: string) => SecureStore.setItemAsync(SERVER, origin, OPTIONS),
};
