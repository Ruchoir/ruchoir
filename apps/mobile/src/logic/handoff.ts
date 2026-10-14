/**
 * The addresses of the passage through the instance's web page (step 6f, `auth/browser.ts`): the
 * page the app opens, and the address the page sends the app back to. Kept free of the native
 * modules so Node tests them.
 */

/** Where the page sends the app back after signing it in, and after adding a passkey. */
export const SIGN_IN_RETURN = "ruchoir://auth";
export const PASSKEY_RETURN = "ruchoir://passkey";

const page = (server: string) => `${server.replace(/\/+$/, "")}/n/`;

/** The page that signs the app in: the challenge, and the address already typed, if any. */
export function signInUrl(server: string, challenge: string, email?: string): string {
  const query = new URLSearchParams({ c: challenge });
  if (email) query.set("e", email);
  return `${page(server)}?${query.toString().replace(/\+/g, "%20")}`;
}

/** The page that adds a passkey, signed in by the single-use code. */
export function passkeyUrl(server: string, code: string): string {
  return `${page(server)}?h=${encodeURIComponent(code)}`;
}

/**
 * The parameters of the address the page sent the app back to, when it is the one expected (exactly
 * that address, with or without a query); null for anything else.
 */
export function redirectParams(url: string, expected: string): Record<string, string> | null {
  if (url !== expected && !url.startsWith(`${expected}?`)) return null;
  const query = url.slice(expected.length + 1);
  return Object.fromEntries(new URLSearchParams(query));
}

/** Bytes as lowercase hex: the app's verifier. */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
