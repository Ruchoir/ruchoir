// Checks the App Store Connect API key before the long iPhone build (.github/workflows/mobile-build.yml):
// the shape of each secret, then one call to App Store Connect with it, which also finds the app.
// Prints no secret, only what is wrong with it. Exits 1 on any problem.
//
// Reads APPLE_TEAM_ID, APPLE_API_KEY_ID, APPLE_API_ISSUER_ID and KEY_PATH (the .p8 written by the
// workflow) from the environment, and BUNDLE_ID.
import { ApiError, api, loadKey } from "./app-store-connect.mjs";

const {
  APPLE_TEAM_ID: team = "",
  APPLE_API_KEY_ID: keyId = "",
  APPLE_API_ISSUER_ID: issuer = "",
} = process.env;
const keyPath = process.env.KEY_PATH;
const bundleId = process.env.BUNDLE_ID;

const problems = [];
for (const [name, value] of Object.entries({
  APPLE_TEAM_ID: team,
  APPLE_API_KEY_ID: keyId,
  APPLE_API_ISSUER_ID: issuer,
})) {
  if (value !== value.trim()) problems.push(`${name} has a space or a line break around it.`);
}
const tenChars = /^[A-Z0-9]{10}$/;
if (!tenChars.test(team)) problems.push("APPLE_TEAM_ID is not 10 capital letters or digits.");
if (!tenChars.test(keyId)) problems.push("APPLE_API_KEY_ID is not 10 capital letters or digits.");
if (team && team === keyId) problems.push("APPLE_API_KEY_ID holds the team ID, not the key's ID.");
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(issuer)) {
  problems.push(
    "APPLE_API_ISSUER_ID is not shaped like the issuer ID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx, shown above the team keys).",
  );
}

let key;
try {
  key = loadKey(keyPath);
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    problems.push("APPLE_API_KEY_P8 is a private key, but not an App Store Connect one (P-256).");
  }
} catch {
  problems.push(
    "APPLE_API_KEY_P8 is not a readable private key: paste the whole .p8, BEGIN and END lines included.",
  );
}

if (problems.length) {
  for (const p of problems) console.log(`::error::${p}`);
  process.exit(1);
}

let body;
try {
  body = await api(key, "GET", `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}`);
} catch (error) {
  if (!(error instanceof ApiError)) throw error;
  if (error.status === 401) {
    console.log(
      "::error::App Store Connect refuses the key. The key ID, the issuer ID and the .p8 must belong to the same team key, and that key must not be revoked (docs/mobile-builds.md).",
    );
  } else if (error.status === 403) {
    console.log(
      "::error::The key is known but not allowed: it must be a team key with the Admin role.",
    );
  } else {
    console.log(`::error::${error.message}`);
  }
  process.exit(1);
}
if (!body.data?.length) {
  console.log(
    `::error::The key works, but App Store Connect has no app with the bundle ID ${bundleId}: create it first.`,
  );
  process.exit(1);
}
console.log(`The key works, and App Store Connect has the app ${bundleId}.`);
