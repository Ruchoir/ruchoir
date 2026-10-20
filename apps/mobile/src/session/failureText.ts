import { key } from "../i18n";
import type { FailureCode } from "./SessionProvider";

/** The sentence each sign-in failure is told with. */
export const FAILURE_TEXT = {
  empty: key("auth.error.empty"),
  insecure: key("auth.error.insecure"),
  invalid: key("auth.error.invalid"),
  unreachable: key("auth.error.unreachable"),
  notRuchoir: key("auth.error.notRuchoir"),
  outdated: key("auth.error.outdated"),
  invalid_credentials: key("auth.error.invalidCredentials"),
  too_many_attempts: key("auth.error.tooManyAttempts"),
  email_not_verified: key("auth.error.emailNotVerified"),
  account_locked: key("auth.error.accountLocked"),
  invalid_code: key("auth.error.invalidCode"),
  invalid_token: key("auth.error.invalidToken"),
  email_taken: key("auth.error.emailTaken"),
  weak_password: key("auth.error.weakPassword"),
  breached_password: key("auth.error.breachedPassword"),
  passkeyOnly: key("auth.error.passkeyOnly"),
  alreadyAdded: key("auth.error.alreadyAdded"),
  unknown: key("auth.error.unknown"),
} satisfies Record<FailureCode, string>;
