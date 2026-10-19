// Makes sure Apple knows every bundle id the iPhone build signs (the app and its extensions) and the
// capabilities they use, before the export asks for their profiles (.github/workflows/mobile-build.yml).
// Idempotent: what exists is left as it is. Uses the same App Store Connect key as the upload.
//
// Reads the key (see app-store-connect.mjs).
import { ApiError, api, loadKey } from "./app-store-connect.mjs";

const key = loadKey();

/** Every bundle id the build embeds, with the capabilities each needs beyond the defaults. */
const BUNDLES = [
  { identifier: "com.ruchoir.app", name: "Ruchoir", capabilities: ["PUSH_NOTIFICATIONS"] },
  { identifier: "com.ruchoir.app.notifications", name: "Ruchoir notifications", capabilities: [] },
  { identifier: "com.ruchoir.app.widgets", name: "Ruchoir widgets", capabilities: [] },
];

async function bundleId(identifier, name) {
  const found = await api(key, "GET", `/v1/bundleIds?filter[identifier]=${encodeURIComponent(identifier)}&limit=5`);
  // The filter matches prefixes too: only the exact one counts.
  const exact = found.data?.find((b) => b.attributes?.identifier === identifier);
  if (exact) return exact.id;
  const created = await api(key, "POST", "/v1/bundleIds", {
    data: { type: "bundleIds", attributes: { identifier, name, platform: "IOS" } },
  });
  console.log(`Registered ${identifier}.`);
  return created.data.id;
}

async function enable(id, identifier, capabilityType) {
  try {
    await api(key, "POST", "/v1/bundleIdCapabilities", {
      data: {
        type: "bundleIdCapabilities",
        attributes: { capabilityType },
        relationships: { bundleId: { data: { type: "bundleIds", id } } },
      },
    });
    console.log(`${capabilityType} enabled for ${identifier}.`);
  } catch (error) {
    // Already enabled: Apple answers 409.
    if (error instanceof ApiError && error.status === 409) return;
    throw error;
  }
}

for (const bundle of BUNDLES) {
  const id = await bundleId(bundle.identifier, bundle.name);
  for (const capability of bundle.capabilities) await enable(id, bundle.identifier, capability);
}
console.log("Bundle ids ready.");
