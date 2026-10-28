// Assemble a desktop release for the website's server (docs/desktop.md, "Releasing"): from
// the folder where the CI gathered every system's files, write `latest.json`, the updater's
// manifest, and `index.html`, the plain download page the app's "Download" opens (the website's own
// page comes later). Run by `.github/workflows/desktop-build.yml` on a `desktop-v*` tag:
//
//   node infra/desktop-release/assemble.mjs 0.1.0 release/
//
// Every updater archive needs its `.sig` (minisign, from TAURI_SIGNING_PRIVATE_KEY): a missing one
// stops the release rather than publish an update the apps would refuse.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [version, dir] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version ?? "") || !dir) {
  console.error("usage: node assemble.mjs <version> <folder>");
  process.exit(2);
}
const base = `https://ruchoir.com/desktop/v${version}`;
const files = readdirSync(dir);
const one = (test, what) => {
  const found = files.filter((f) => test.test(f));
  if (found.length !== 1) {
    console.error(`expected one ${what}, found ${found.length}: ${found.join(", ")}`);
    process.exit(1);
  }
  return found[0];
};
const signed = (file) => {
  const sig = `${file}.sig`;
  if (!files.includes(sig)) {
    console.error(`${file} has no signature`);
    process.exit(1);
  }
  return { signature: readFileSync(join(dir, sig), "utf8").trim(), url: `${base}/${encodeURIComponent(file)}` };
};

// The files the updater installs: the NSIS installer, the macOS app archive (universal: both
// processors), the AppImage.
const windows = one(/-setup\.exe$/, "Windows installer");
const mac = one(/\.app\.tar\.gz$/, "macOS app archive");
const appimage = one(/\.AppImage$/, "AppImage");
const manifest = {
  version,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": signed(windows),
    "darwin-x86_64": signed(mac),
    "darwin-aarch64": signed(mac),
    "linux-x86_64": signed(appimage),
  },
};
writeFileSync(join(dir, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

// What a person downloads, by system.
const dmg = one(/\.dmg$/, "macOS disk image");
const deb = one(/\.deb$/, "Debian package");
const rpm = one(/\.rpm$/, "RPM package");
const link = (file, label) => `<li><a href="v${version}/${encodeURIComponent(file)}">${label}</a> <small>${file}</small></li>`;
writeFileSync(
  join(dir, "index.html"),
  `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Ruchoir ${version} pour ordinateur</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; color: #15171c; }
  h1 { font-size: 1.5rem; } small { color: #6b717d; margin-left: .5rem; } li { margin: .5rem 0; }
</style>
</head>
<body>
<h1>Ruchoir ${version} pour ordinateur</h1>
<p>Version de test. Les prochaines versions s’installent d’elles-mêmes (sauf paquets .deb et .rpm).</p>
<ul>
${link(windows, "Windows 10 et 11")}
${link(dmg, "macOS 12 et plus")}
${link(appimage, "Linux, AppImage (mises à jour automatiques)")}
${link(deb, "Linux, paquet .deb")}
${link(rpm, "Linux, paquet .rpm")}
</ul>
</body>
</html>
`,
);
console.log(`latest.json and index.html written for ${version}`);
