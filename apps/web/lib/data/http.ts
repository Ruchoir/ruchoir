/**
 * The HTTP client behind the data seam.
 *
 * Every real implementation of `lib/data` calls the Rust API through this one helper, so the rules
 * that make the client sovereign live in a single place: same-origin only, relative paths, and the
 * session cookie (`__Host-ruchoir_session`, HttpOnly) sent automatically. The strict CSP
 * (`connect-src 'self'`) forbids any cross-origin request, so an absolute URL here would fail at
 * runtime; callers pass API-relative paths like `/api/v1/me/spaces`.
 */

/** Base path for the versioned API. Every helper path is joined onto this. */
const API_BASE = "/api/v1";

/**
 * A failed API call. Carries the HTTP status so callers can branch (401 -> re-login, 404 -> gone)
 * without re-reading the response. `body` holds the parsed error payload when the API returned one.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/** True for an {@link ApiError} carrying this exact HTTP status. Convenience for call sites. */
export function isApiError(err: unknown, status?: number): err is ApiError {
  return err instanceof ApiError && (status === undefined || err.status === status);
}

/**
 * The API's machine-readable error code (`{ "error": "email_not_verified", … }`), when the failure
 * carries one. Call sites branch on this rather than on the human message, which is prose meant for
 * display and may change; `null` for a transport error or an unexpected body.
 */
export function apiErrorCode(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const body = err.body;
  if (body && typeof body === "object") {
    const code = (body as Record<string, unknown>).error;
    if (typeof code === "string" && code) return code;
  }
  return null;
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

type RequestOptions = {
  /** JSON request body. Serialised and sent with a `content-type: application/json` header. */
  json?: unknown;
  /** Abort signal, so a caller (or an unmounting screen) can cancel an in-flight request. */
  signal?: AbortSignal;
};

/**
 * Perform a JSON API request and return the parsed body typed as `T`.
 *
 * Throws {@link ApiError} on any non-2xx response (with the status and parsed error body), and lets
 * network/abort errors propagate as the native `TypeError`/`AbortError` so callers can tell a
 * transport failure from an API rejection. A 204 (or empty body) resolves to `undefined`.
 */
export async function apiRequest<T>(method: Method, path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    // Same-origin: the API serves this bundle and sets the session cookie; never send credentials cross-origin.
    credentials: "same-origin",
    headers: opts.json === undefined ? undefined : { "content-type": "application/json" },
    body: opts.json === undefined ? undefined : JSON.stringify(opts.json),
    signal: opts.signal,
  });

  const text = await res.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      // A non-JSON body (e.g. an HTML error page from a misconfigured proxy): keep the raw text so
      // the error carries something legible.
      body = text;
    }
  }

  if (!res.ok) {
    throw new ApiError(res.status, apiErrorMessage(body, res.status), body);
  }
  return body as T;
}

/** GET helper. */
export function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  return apiRequest<T>("GET", path, { signal });
}

/** POST helper with a JSON body. */
export function apiPost<T>(path: string, json?: unknown, signal?: AbortSignal): Promise<T> {
  return apiRequest<T>("POST", path, { json, signal });
}

/** PUT helper with an optional JSON body (many PUT endpoints are bodyless toggles). */
export function apiPut<T>(path: string, json?: unknown, signal?: AbortSignal): Promise<T> {
  return apiRequest<T>("PUT", path, { json, signal });
}

/** PATCH helper with a JSON body. */
export function apiPatch<T>(path: string, json?: unknown, signal?: AbortSignal): Promise<T> {
  return apiRequest<T>("PATCH", path, { json, signal });
}

/** DELETE helper. */
export function apiDelete<T>(path: string, signal?: AbortSignal): Promise<T> {
  return apiRequest<T>("DELETE", path, { signal });
}

/**
 * Pull a human-readable message out of an API error body. The API returns problem details as
 * `{ error, message }` (or similar); fall back to a generic line keyed on the status when it does
 * not, so an unexpected shape never surfaces as `[object Object]`.
 */
function apiErrorMessage(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const rec = body as Record<string, unknown>;
    for (const key of ["message", "error", "detail"]) {
      if (typeof rec[key] === "string" && rec[key]) return rec[key] as string;
    }
  }
  if (typeof body === "string" && body) return body;
  return `HTTP ${status}`;
}
