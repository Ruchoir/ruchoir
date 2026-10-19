import { apiErrorCode } from "@/lib/data/http";
import { key, type TranslationKey } from "@/lib/i18n";

/**
 * French copy for each authentication failure the API can report. The API answers with a
 * machine-readable code (`{ "error": "email_taken", … }`) plus an English message meant for
 * operators; the client owns what the user reads.
 */
const AUTH_MESSAGES: Record<string, TranslationKey> = {
  invalid_credentials: key("error.invalidCredentials"),
  unauthorized: key("error.sessionExpired"),
  email_taken: key("error.emailTaken"),
  weak_password: key("error.passwordShort"),
  breached_password: key("error.passwordBreached"),
  account_locked: key("error.accountLocked"),
  too_many_attempts: key("error.tooManyAttempts"),
  email_not_verified: key("error.confirmEmailFirst"),
  invalid_token: key("error.invalidLink"),
  invalid_code: key("error.wrongCode"),
};

/**
 * The dictionary key for a failed auth request: the mapped code, else the caller's fallback key.
 *
 * Keys rather than sentences, so the table can be built at module load and the text looked up where
 * it is shown.
 */
export function authMessage(err: unknown, fallbackKey: TranslationKey): TranslationKey {
  const code = apiErrorCode(err);
  return (code && AUTH_MESSAGES[code]) || fallbackKey;
}
