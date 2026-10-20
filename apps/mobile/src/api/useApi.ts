/**
 * The client of the instance a screen belongs to.
 *
 * The app holds one `RuchoirClient` per instance (ADR 0007). Every screen reaches the API through
 * the client of its instance, provided by the scope it is mounted in (`accounts/InstanceScope`), or
 * by the sign-in flow for the instance being added. A request started on one instance therefore
 * always finishes there, with that instance's token, whatever the person opens meanwhile.
 */
import type { RuchoirClient } from "@ruchoir/client";
import { createContext, createElement, useContext, type ReactNode } from "react";

import { isInstanceUrl } from "./sameInstance";

const ApiContext = createContext<RuchoirClient | null>(null);

export function ApiProvider({ client, children }: { client: RuchoirClient; children: ReactNode }) {
  return createElement(ApiContext.Provider, { value: client }, children);
}

/** The client of the instance this screen belongs to. */
export function useApi(): RuchoirClient {
  const client = useContext(ApiContext);
  if (!client) throw new Error("useApi outside an ApiProvider");
  return client;
}

/**
 * The header that proves who is asking, for a request the client does not make itself (an image, a
 * download), but only towards the client's own instance: a picture hosted anywhere else is fetched
 * without the token, which must never leave for a third party.
 */
export function authHeadersFor(client: RuchoirClient, url: string): Record<string, string> {
  return isInstanceUrl(url, client.options().baseUrl || null) ? client.authInit().headers : {};
}
