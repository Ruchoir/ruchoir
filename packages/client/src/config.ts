/**
 * Where the client sends its requests, and how it proves who is asking.
 *
 * The same code serves two hosts. The web app is served by the API itself: it calls relative paths,
 * the browser attaches the `__Host-` session cookie, and its strict CSP (`connect-src 'self'`) forbids
 * anything else. Those are the defaults, so the web configures nothing but its locale. A native app
 * talks to whichever instance its person chose: it sets that origin, presents the session token it
 * keeps in the keychain as a bearer, and never sends a cookie.
 */

export type ClientOptions = {
  /** The instance origin (`https://ruchoir.example.org`), or empty for same-origin relative calls. */
  baseUrl: string;
  /** The `Authorization` header value for each request, or null to send none. */
  authorization: () => string | null;
  /** How a sign-in asks for its session: the browser's cookie, or a token for a native app. */
  sessionDelivery: "cookie" | "token";
  /** The interface language, sent where the server writes to the person (mails, documents). */
  locale: () => string;
  /** Open the realtime socket. A native app passes one that carries the bearer header. */
  openSocket: (url: string) => WebSocket;
  /** Called once per request answered 401, before the error is thrown (a native app signs out). */
  onUnauthorized: () => void;
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
  const baseUrl = patch.baseUrl === undefined ? options.baseUrl : patch.baseUrl.replace(/\/+$/, "");
  options = { ...options, ...patch, baseUrl };
}

/** Back to the defaults, between two tests. */
export function resetClientForTests(): void {
  options = { ...DEFAULTS };
}

/** The current options. Read on every request, so a change applies to the next one. */
export function clientOptions(): ClientOptions {
  return options;
}

/** The versioned API root: `/api/v1` on the web, `https://host/api/v1` in an app. */
export function apiBase(): string {
  return `${options.baseUrl}/api/v1`;
}

/**
 * The origin the API answers on: the configured one, else the page's own.
 *
 * Only the web reaches the fallback, and only in a browser, which is where `window` exists.
 */
export function apiOrigin(): string {
  return options.baseUrl || window.location.origin;
}

/**
 * Make a path the server returned (`/api/v1/users/u1/avatar`) usable from where the client runs.
 * Relative on the web, where the page shares the API's origin; absolute in an app. A full URL, or a
 * `data:` one, is left as it is.
 */
export function absoluteUrl(pathOrUrl: string): string {
  return pathOrUrl.startsWith("/") ? `${options.baseUrl}${pathOrUrl}` : pathOrUrl;
}

/**
 * What every raw `fetch` (an upload, a heartbeat) carries besides its body: the credentials mode and,
 * in an app, the bearer. `apiRequest` uses the same, so no request leaves without them.
 */
export function authInit(): { credentials: RequestCredentials; headers: Record<string, string> } {
  const authorization = options.authorization();
  return {
    credentials: options.baseUrl ? "omit" : "same-origin",
    headers: authorization ? { authorization } : {},
  };
}
