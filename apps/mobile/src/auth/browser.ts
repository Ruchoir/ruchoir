/**
 * Passkeys, through the instance's own web page (step 6f, ADR 0005): an app cannot run a passkey
 * ceremony for an instance it does not know at build time, so it opens the instance's page in the
 * system's authentication browser (`ASWebAuthenticationSession` on iOS, Custom Tabs on Android), and
 * the page sends it back on `ruchoir://` (`logic/handoff.ts`).
 *
 * - Signing in: the app keeps a random verifier and sends only its SHA-256 (the challenge); the
 *   page, once the person has signed in and allowed the app, hands back a single-use code bound to
 *   that challenge, which the app trades with the verifier for its own session.
 * - Adding a passkey: a single-use code from the app signs the page in; the page adds the passkey.
 *
 * Expo Go on Android cannot be sent back to (Custom Tabs need the app's own link); iOS's session
 * catches the address itself, so it works there too.
 */
import { createWebHandoff } from "@ruchoir/client";
import Constants, { ExecutionEnvironment } from "expo-constants";
import * as Crypto from "expo-crypto";
import * as WebBrowser from "expo-web-browser";
import { Platform } from "react-native";

import { PASSKEY_RETURN, SIGN_IN_RETURN, passkeyUrl, redirectParams, signInUrl, toHex } from "../logic/handoff";

export function canUseBrowserHandoff(): boolean {
  return !(Platform.OS === "android" && Constants.executionEnvironment === ExecutionEnvironment.StoreClient);
}

/**
 * Sign in on the instance's page: the code it handed back and the verifier to trade it with, or null
 * when the person closed the page or declined.
 */
export async function signInThroughBrowser(server: string, email?: string): Promise<{ code: string; verifier: string } | null> {
  const verifier = toHex(Crypto.getRandomBytes(32));
  const challenge = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier);
  const result = await WebBrowser.openAuthSessionAsync(signInUrl(server, challenge.toLowerCase(), email), SIGN_IN_RETURN, {
    // Nothing of this browsing is kept: the passkey lives in the phone's keychain, not in cookies.
    preferEphemeralSession: true,
  });
  if (result.type !== "success") return null;
  const code = redirectParams(result.url, SIGN_IN_RETURN)?.code;
  return code ? { code, verifier } : null;
}

/** Add a passkey on the instance's page; true when the page says it was added. */
export async function addPasskeyThroughBrowser(server: string): Promise<boolean> {
  const code = await createWebHandoff();
  const result = await WebBrowser.openAuthSessionAsync(passkeyUrl(server, code), PASSKEY_RETURN, {
    preferEphemeralSession: true,
  });
  if (result.type !== "success") return false;
  return redirectParams(result.url, PASSKEY_RETURN)?.added === "1";
}
