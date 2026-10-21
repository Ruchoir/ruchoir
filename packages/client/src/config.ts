/**
 * Where the client sends its requests, and how it proves who is asking.
 *
 * The same code serves two hosts. The web app is served by the API itself: it calls relative paths,
 * the browser attaches the `__Host-` session cookie, and its strict CSP (`connect-src 'self'`) forbids
 * anything else. Those are the defaults, so the web configures nothing but its locale. A native app
 * talks to whichever instance its person chose: it sets that origin, presents the session token it
 * keeps in the keychain as a bearer, and never sends a cookie.
 *
 * The module-level options belong to the default client, the one the web uses. An app that talks to
 * several instances at once gives each its own options through `createClient` (`client.ts`); the
 * `...Of(options)` helpers below are what both read.
 */

export type ClientOptions = {
  /** The instance origin (`https://ruchoir.example.org`), or empty for same-origin relative calls. */
  baseUrl: string;
  /**
   * The instance's own address when `baseUrl` is not it: the desktop app reaches every instance
   * through a path of its own origin (`/i/<id>`), yet a public link copied to someone, or the
   * realtime socket's address, must name the instance itself. Unset everywhere else.
   */
  publicOrigin?: string;
  /** The `Authorization` header value for each request, or null to send none. */
  authorization: () => string | null;
  /** How a sign-in asks for its session: the browser's cookie, or a token for a native app. */
  sessionDelivery: "cookie" | "token";
  /** The interface language, sent where the server writes to the person (mails, documents). */
  locale: () => string;
  /** Open the realtime socket. A native app passes one that carries the bearer header. */
  openSocket: (url: string) => WebSocket;
  /**
   * Called once per request answered 401, before the error is thrown (a native app signs out), with
   * the API's error code: `invalid_credentials` is a wrong password typed to confirm an action, not a
   * session that ended.
   */
  onUnauthorized: (code?: string) => void;
};

const DEFAULTS: ClientOptions = {
  baseUrl: "",
  authorization: () => null,
  sessionDelivery: "cookie",
  locale: () => "fr",
  openSocket: (url) => new WebSocket(url),
  onUnauthorized: () => {},
};

let options: ClientOptions = { ...DEFAULTS };

/** Set some options; the others keep their current value. */
export function configureClient(patch: Partial<ClientOptions>): void {
  options = withOptions(patch, options);
}

/** Back to the defaults, between two tests. */
export function resetClientForTests(): void {
  options = { ...DEFAULTS };
}

/** The current options. Read on every request, so a change applies to the next one. */
export function clientOptions(): ClientOptions {
  return options;
}

/** The versioned API root of `options`: `/api/v1` on the web, `https://host/api/v1` in an app. */
export function apiBaseOf(options: ClientOptions): string {
  return `${options.baseUrl}/api/v1`;
}

/**
 * The origin the API of `options` answers on: its public origin if set, else the configured base,
 * else the page's own.
 *
 * Only the web reaches the fallback, and only in a browser, which is where `window` exists.
 */
export function apiOriginOf(options: ClientOptions): string {
  return options.publicOrigin || options.baseUrl || window.location.origin;
}

/**
 * Make a path the server returned (`/api/v1/users/u1/avatar`) usable from where the client runs.
 * Relative on the web, where the page shares the API's origin; absolute in an app. A full URL, or a
 * `data:` one, is left as it is.
 */
export function absoluteUrlOf(options: ClientOptions, pathOrUrl: string): string {
  return pathOrUrl.startsWith("/") ? `${options.baseUrl}${pathOrUrl}` : pathOrUrl;
}

/**
 * What every raw `fetch` (an upload, a heartbeat) carries besides its body: the credentials mode and,
 * in an app, the bearer. `apiRequest` uses the same, so no request leaves without them.
 */
export function authInitOf(options: ClientOptions): { credentials: RequestCredentials; headers: Record<string, string> } {
  const authorization = options.authorization();
  return {
    credentials: options.baseUrl ? "omit" : "same-origin",
    headers: authorization ? { authorization } : {},
  };
}

/** The options a client starts from: the defaults, with `patch` applied as `configureClient` does. */
export function withOptions(patch: Partial<ClientOptions>, base: ClientOptions = DEFAULTS): ClientOptions {
  const baseUrl = patch.baseUrl === undefined ? base.baseUrl : patch.baseUrl.replace(/\/+$/, "");
  return { ...base, ...patch, baseUrl };
}

// The default client's helpers, over the options `configureClient` sets.

/** The versioned API root: `/api/v1` on the web, `https://host/api/v1` in an app. */
export function apiBase(): string {
  return apiBaseOf(options);
}

/** The origin the API answers on (see {@link apiOriginOf}). */
export function apiOrigin(): string {
  return apiOriginOf(options);
}

/** A server path made usable from where the client runs (see {@link absoluteUrlOf}). */
export function absoluteUrl(pathOrUrl: string): string {
  return absoluteUrlOf(options, pathOrUrl);
}

/** The credentials and bearer of a raw `fetch` (see {@link authInitOf}). */
export function authInit(): { credentials: RequestCredentials; headers: Record<string, string> } {
  return authInitOf(options);
}
