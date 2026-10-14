/**
 * Point the shared client (`@ruchoir/client`) at the instance the person chose.
 *
 * Every request carries the session token as a bearer, the realtime socket too (React Native's
 * `WebSocket` takes headers, which a browser's does not), and sign-in asks for a token rather than a
 * cookie. The token is held here in memory for the synchronous header provider; the Keychain is its
 * home between launches (`session/store.ts`).
 */
import { configureClient } from "@ruchoir/client";

import i18n from "../i18n";
import { forgetUploadLimit } from "./limits";
import { isInstanceUrl } from "./sameInstance";

let token: string | null = null;
let origin: string | null = null;

/** React Native's `WebSocket` constructor, which takes request headers as a third argument. */
type NativeWebSocket = new (
  url: string,
  protocols?: string | string[],
  options?: { headers: Record<string, string> },
) => WebSocket;

export function setSessionToken(value: string | null): void {
  token = value;
}

/** The session token and the instance, for what runs beside the client (phone notifications). */
export function currentSession(): { token: string; origin: string } | null {
  return token && origin ? { token, origin } : null;
}

/** The header that proves who is asking, for the requests the client does not make itself. */
export function authHeaders(): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

/**
 * The same header for an image or a download, but only towards the instance itself: a picture
 * hosted anywhere else is fetched without the token, which must never leave for a third party.
 */
export function authHeadersFor(url: string): Record<string, string> {
  return isInstanceUrl(url, origin) ? authHeaders() : {};
}

export function connectTo(instance: string, onUnauthorized: (code?: string) => void): void {
  origin = instance;
  forgetUploadLimit();
  configureClient({
    baseUrl: instance,
    sessionDelivery: "token",
    authorization: () => (token ? `Bearer ${token}` : null),
    locale: () => i18n.language,
    openSocket: (url) => new (WebSocket as unknown as NativeWebSocket)(url, undefined, { headers: authHeaders() }),
    onUnauthorized,
  });
}
