// Uploads the iPhone build (.ipa) to App Store Connect through its API's build uploads, then waits
// for App Store Connect to take it in. Used by .github/workflows/mobile-build.yml instead of Xcode's
// own upload, whose content delivery service refused a team key the API itself accepts.
//
// Reads IPA_PATH, BUNDLE_ID, VERSION, BUILD_NUMBER, and the key (see app-store-connect.mjs).
import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, statSync, createReadStream } from "node:fs";
import { basename } from "node:path";

import { api, loadKey } from "./app-store-connect.mjs";

const { IPA_PATH: ipa, BUNDLE_ID: bundleId, VERSION: version, BUILD_NUMBER: build } = process.env;
const key = loadKey();

function md5(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("md5");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

function slice(path, offset, length) {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, offset);
    return buffer;
  } finally {
    closeSync(fd);
  }
}

const apps = await api(key, "GET", `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}`);
const appId = apps.data?.[0]?.id;
if (!appId) throw new Error(`App Store Connect has no app with the bundle ID ${bundleId}.`);

const upload = await api(key, "POST", "/v1/buildUploads", {
  data: {
    type: "buildUploads",
    attributes: { cfBundleShortVersionString: version, cfBundleVersion: build, platform: "IOS" },
    relationships: { app: { data: { type: "apps", id: appId } } },
  },
});
const uploadId = upload.data.id;
console.log(`Build upload ${uploadId} created for ${version} (${build}).`);

const size = statSync(ipa).size;
const reservation = await api(key, "POST", "/v1/buildUploadFiles", {
  data: {
    type: "buildUploadFiles",
    attributes: {
      assetType: "ASSET",
      fileName: basename(ipa),
      fileSize: size,
      uti: "com.apple.ipa",
    },
    relationships: { buildUpload: { data: { type: "buildUploads", id: uploadId } } },
  },
});
const fileId = reservation.data.id;
const operations = reservation.data.attributes.uploadOperations ?? [];
console.log(`Sending ${(size / 1e6).toFixed(1)} MB in ${operations.length} part(s).`);

for (const op of operations) {
  const headers = Object.fromEntries((op.requestHeaders ?? []).map((h) => [h.name, h.value]));
  const response = await fetch(op.url, {
    method: op.method,
    headers,
    body: slice(ipa, op.offset, op.length),
  });
  if (!response.ok) {
    throw new Error(
      `Part ${op.partNumber ?? op.offset} refused: ${response.status} ${await response.text()}`,
    );
  }
}

await api(key, "PATCH", `/v1/buildUploadFiles/${fileId}`, {
  data: {
    type: "buildUploadFiles",
    id: fileId,
    attributes: {
      uploaded: true,
      sourceFileChecksums: { file: { algorithm: "MD5", hash: await md5(ipa) } },
    },
  },
});
console.log("Sent. Waiting for App Store Connect to take the build in.");

// App Store Connect checks the file, then hands it to TestFlight's processing (which e-mails the
// account holder when the build is ready). A failure here names what is wrong with the build.
const deadline = Date.now() + 20 * 60 * 1000;
for (;;) {
  const { data } = await api(key, "GET", `/v1/buildUploads/${uploadId}`);
  const state = data.attributes.state ?? {};
  for (const w of state.warnings ?? [])
    console.log(`::warning::${w.description ?? w.code ?? JSON.stringify(w)}`);
  if (state.state === "COMPLETE") {
    console.log("App Store Connect took the build in: TestFlight is processing it.");
    break;
  }
  if (state.state === "FAILED") {
    for (const e of state.errors ?? [])
      console.log(`::error::${e.description ?? e.code ?? JSON.stringify(e)}`);
    process.exit(1);
  }
  if (Date.now() > deadline) {
    console.log(
      `::warning::Still ${state.state} after twenty minutes; App Store Connect carries on alone.`,
    );
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 20_000));
}
