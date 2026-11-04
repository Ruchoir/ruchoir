/**
 * The phone's clients, one per instance, and the session tokens they present (ADR 0007).
 *
 * Kept outside React: a client lives as long as the app, and sends whatever token is held for its
 * instance at the moment of each request, which a render must never decide. The Keychain is the
 * tokens' home between launches (`store.ts`); this is their copy in memory, for the synchronous
 * header providers.
 */
import { createClient, type RuchoirClient } from "@ruchoir/client";

import i18n from "../i18n";
import type { InstanceEntry } from "./registry";

/** React Native's `WebSocket` constructor, which takes request headers as a third argument. */
type NativeWebSocket = new (
  url: string,
  protocols?: string | string[],
  options?: { headers: Record<string, string> },
) => WebSocket;

export class InstanceClients {
  private readonly clients = new Map<string, RuchoirClient>();
  private readonly held = new Map<string, string | null>();
  private unauthorized: (id: string, code?: string) => void = () => {};
  /** The instances whose space on screen is looked at as a role: their background writes are not sent. */
  private readonly previewing = new Map<string, string | undefined>();
  private readonly refused = new Map<string, (request: { method: string; path: string }) => void>();

  /** The client of an instance, made the first time it is asked for. */
  client(entry: InstanceEntry): RuchoirClient {
    let client = this.clients.get(entry.id);
    if (!client) {
      const bearer = () => {
        const token = this.held.get(entry.id);
        return token ? `Bearer ${token}` : null;
      };
      client = createClient({
        baseUrl: entry.origin,
        sessionDelivery: "token",
        authorization: bearer,
        locale: () => i18n.language,
        // The socket carries the bearer too (React Native's `WebSocket` takes headers, a browser's not).
        openSocket: (url) => {
          const authorization = bearer();
          return new (WebSocket as unknown as NativeWebSocket)(url, undefined, { headers: authorization ? { authorization } : {} });
        },
        onUnauthorized: (code) => this.unauthorized(entry.id, code),
        previewActive: () => this.previewing.has(entry.id),
        onPreviewReadOnly: (request) => this.refused.get(entry.id)?.(request),
      });
      this.clients.set(entry.id, client);
    }
    return client;
  }

  token(id: string): string | null {
    return this.held.get(id) ?? null;
  }

  hold(id: string, token: string | null): void {
    this.held.set(id, token);
  }

  /** Forget an instance's client and token, when the instance is removed from the phone. */
  drop(id: string): void {
    this.clients.delete(id);
    this.held.delete(id);
    this.previewing.delete(id);
    this.refused.delete(id);
  }

  /**
   * Say whether the space shown for an instance is a preview (and which space): the client then sends
   * no background write.
   */
  setPreviewing(id: string, on: boolean, spaceId?: string): void {
    if (on) this.previewing.set(id, spaceId);
    else this.previewing.delete(id);
  }

  /** The space an instance is previewing, when it is. */
  previewSpace(id: string): string | undefined {
    return this.previewing.get(id);
  }

  /** Whether any instance is previewing: what the account does as a whole (preferences) waits then. */
  anyPreviewing(): boolean {
    return this.previewing.size > 0;
  }

  /** Who hears of a write the server refused because of a preview, once per refused request. Returns the way to stop listening. */
  onPreviewReadOnly(id: string, handler: (request: { method: string; path: string }) => void): () => void {
    this.refused.set(id, handler);
    return () => {
      if (this.refused.get(id) === handler) this.refused.delete(id);
    };
  }

  /** What a 401 on an instance does (the accounts sign it out there). */
  onUnauthorized(handler: (id: string, code?: string) => void): void {
    this.unauthorized = handler;
  }
}
