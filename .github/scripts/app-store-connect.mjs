// A minimal App Store Connect API client for the phone build workflow (.github/workflows/mobile-build.yml),
// on Node's own crypto and fetch: a token signed with the team key, and JSON calls that fail loudly.
// Reads APPLE_API_KEY_ID, APPLE_API_ISSUER_ID and KEY_PATH (the .p8 the workflow wrote).
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";

const API = "https://api.appstoreconnect.apple.com";

export class ApiError extends Error {
  constructor(status, body) {
    const details = (body?.errors ?? []).map((e) => e.detail || e.title).filter(Boolean);
    super(`App Store Connect answered ${status}${details.length ? `: ${details.join(" ")}` : ""}`);
    this.status = status;
  }
}

export function loadKey(path = process.env.KEY_PATH) {
  return createPrivateKey(readFileSync(path, "utf8"));
}

/** A token as App Store Connect wants it: ES256, the signature as raw r||s, twenty minutes at most. */
export function token(
  key,
  keyId = process.env.APPLE_API_KEY_ID,
  issuer = process.env.APPLE_API_ISSUER_ID,
) {
  const b64 = (value) => Buffer.from(value).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }))}.${b64(
    JSON.stringify({ iss: issuer, iat: now, exp: now + 1200, aud: "appstoreconnect-v1" }),
  )}`;
  const signature = sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" });
  return `${unsigned}.${b64(signature)}`;
}

/** One JSON call; a fresh token each time, so a long upload never outlives it. */
export async function api(key, method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token(key)}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, json);
  return json;
}
