/**
 * The small rules of signing up, kept apart from the screens so Node can test them.
 *
 * The password rule is the server's (`MIN_PASSWORD_LEN` in `apps/api/src/auth/password.rs`), shown
 * as the person types; the server stays the judge, and also refuses passwords known from breaches.
 */

export const MIN_PASSWORD = 12;

/** Long enough for the server, counted in characters as it counts them. */
export function passwordLongEnough(password: string): boolean {
  return [...password].length >= MIN_PASSWORD;
}

/** What was typed in a code field, as the six digits the server reads. */
export function codeDigits(input: string): string {
  return input.replace(/\D/g, "").slice(0, 6);
}

export function codeComplete(code: string): boolean {
  return /^\d{6}$/.test(code);
}
