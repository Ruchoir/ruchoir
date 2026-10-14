/**
 * The key of an authenticator enrolment, read from the `otpauth://` address the API hands out, for
 * someone who types it into an app on another device rather than opening the link on this one.
 */

export function otpauthSecret(url: string): string | null {
  if (!url.startsWith("otpauth://")) return null;
  const query = url.split("?")[1] ?? "";
  const secret = query
    .split("&")
    .map((pair) => pair.split("="))
    .find(([name]) => name === "secret")?.[1];
  return secret ? decodeURIComponent(secret) : null;
}

/** The key in groups of four, as authenticator apps print it. */
export function groupedSecret(secret: string): string {
  return secret.match(/.{1,4}/g)?.join(" ") ?? secret;
}
