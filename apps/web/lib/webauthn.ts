/**
 * Browser-side WebAuthn plumbing for passkey sign-in.
 *
 * The API speaks the WebAuthn JSON shapes (`webauthn-rs`), where every binary field travels as an
 * unpadded base64url string, while `navigator.credentials` speaks `ArrayBuffer`. This module is the
 * only place that translation happens: it decodes a server challenge into the options the browser
 * expects, and encodes the resulting assertion back into the JSON the API verifies.
 *
 * Nothing here is a secret store: the private key never leaves the authenticator, and the assertion
 * is single-use and bound to the pending sign-in it answers.
 */

/** A `POST /auth/mfa/passkey/authenticate/start` challenge, as sent on the wire. */
export type PasskeyChallenge = {
  publicKey: {
    challenge: string;
    timeout?: number;
    rpId?: string;
    allowCredentials?: { type: string; id: string; transports?: string[] }[];
    userVerification?: string;
  };
};

/** An assertion in the JSON shape the API deserialises. */
export type PasskeyAssertion = {
  id: string;
  rawId: string;
  type: string;
  response: {
    authenticatorData: string;
    clientDataJSON: string;
    signature: string;
    userHandle: string | null;
  };
  extensions: Record<string, never>;
};

/** True when this browser exposes WebAuthn. Requires a secure context (HTTPS, or localhost in dev). */
export function isPasskeySupported(): boolean {
  return typeof window !== "undefined" && typeof window.PublicKeyCredential !== "undefined";
}

/**
 * Decode an unpadded base64url string into the bytes `navigator.credentials` expects. The buffer is
 * pinned to `ArrayBuffer` (never a `SharedArrayBuffer`) because that is what `BufferSource` requires.
 */
function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Encode an authenticator buffer as the unpadded base64url the API expects. */
function toBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return window.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Prompt the authenticator for an assertion answering `challenge`, and return it in the API's JSON
 * shape. Rejects when passkeys are unsupported, and when the user dismisses or cancels the prompt
 * (the native `NotAllowedError`), which callers surface as a cancelled step rather than a failure.
 */
export async function getPasskeyAssertion(challenge: PasskeyChallenge): Promise<PasskeyAssertion> {
  if (!isPasskeySupported()) throw new Error("passkeys are not supported by this browser");
  const options = challenge.publicKey;
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: fromBase64Url(options.challenge),
      timeout: options.timeout,
      rpId: options.rpId,
      allowCredentials: (options.allowCredentials ?? []).map((cred) => ({
        type: "public-key" as const,
        id: fromBase64Url(cred.id),
        transports: cred.transports as AuthenticatorTransport[] | undefined,
      })),
      userVerification: options.userVerification as UserVerificationRequirement | undefined,
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("no passkey assertion was produced");

  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    response: {
      authenticatorData: toBase64Url(response.authenticatorData),
      clientDataJSON: toBase64Url(response.clientDataJSON),
      signature: toBase64Url(response.signature),
      userHandle: response.userHandle ? toBase64Url(response.userHandle) : null,
    },
    extensions: {},
  };
}
