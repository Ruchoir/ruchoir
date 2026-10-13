/**
 * The passkey calls, which need the browser's WebAuthn API and so cannot live in the shared client.
 */
import { toSessionUser, type SessionUser, type UserSummaryDto } from "@ruchoir/client/api";
import { apiPost } from "@ruchoir/client/http";
import {
  createPasskeyCredential,
  getPasskeyAssertion,
  type PasskeyChallenge,
  type PasskeyCreationChallenge,
} from "@/lib/webauthn";

/** Register a passkey on this device: challenge, authenticator ceremony, then attestation. */
export async function registerPasskey(): Promise<void> {
  const challenge = await apiPost<PasskeyCreationChallenge>("/auth/mfa/passkey/register/start");
  const credential = await createPasskeyCredential(challenge);
  await apiPost<void>("/auth/mfa/passkey/register/finish", credential);
}

/**
 * Answer the pending challenge with a passkey: fetch the WebAuthn challenge, have the authenticator
 * sign it, and post the assertion back (`/auth/mfa/passkey/authenticate/{start,finish}`). Resolves to
 * the signed-in user; the session cookie is set on the finish response like any other sign-in.
 */
export async function verifyPasskey(mfaToken: string): Promise<SessionUser> {
  const challenge = await apiPost<PasskeyChallenge>("/auth/mfa/passkey/authenticate/start", {
    mfa_token: mfaToken,
  });
  const credential = await getPasskeyAssertion(challenge);
  const dto = await apiPost<UserSummaryDto>("/auth/mfa/passkey/authenticate/finish", {
    mfa_token: mfaToken,
    credential,
  });
  return toSessionUser(dto);
}
