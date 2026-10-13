/**
 * Whether a URL points at the instance the app is signed in to, which is the only place the session
 * token may travel. A picture or a file hosted anywhere else is fetched without it.
 */
export function isInstanceUrl(url: string, origin: string | null): boolean {
  if (!origin) return false;
  // A path of the instance (`/api/v1/...`), but not a protocol-relative URL (`//elsewhere/...`).
  if (url.startsWith("/") && !url.startsWith("//")) return true;
  return url === origin || url.startsWith(`${origin}/`);
}
