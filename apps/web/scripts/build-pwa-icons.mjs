#!/usr/bin/env node
/**
 * Draw the installed-app icons from the Ruchoir mark (`app/icon.png`) into `public/icons/`.
 *
 * Run once, by hand, whenever the mark changes; the output is committed, so a build never depends
 * on it. The images are:
 *
 * - `icon-192.png`, `icon-512.png`: the home-screen and splash icon, the mark on the cream surface.
 * - `maskable-512.png`: the same for platforms that cut the icon into their own shape (a circle, a
 *   squircle). The mark is shrunk into the central safe zone so no cut reaches it.
 * - `app/apple-icon.png`: iOS draws its own rounded corners and never uses transparency, so the
 *   surface is opaque and square. Written into `app/`, where Next's file convention links it.
 * - `badge-96.png`: the monochrome glyph Android shows in the status bar, which only reads the
 *   alpha channel: the mark's silhouette in white.
 *
 * Uses `sharp`, which Next.js already installs for itself; it is resolved through Next rather than
 * added as a dependency of the app.
 */

import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
const require = createRequire(import.meta.url);
const sharp = require(require.resolve("sharp", { paths: [dirname(require.resolve("next/package.json"))] }));

const MARK = join(app, "app", "icon.png");
const OUT = join(app, "public", "icons");
// `--surface-page` of the RuchUI theme (apps/web/app/tokens.css).
const CREAM = { r: 0xf7, g: 0xf3, b: 0xed, alpha: 1 };

mkdirSync(OUT, { recursive: true });

/** The mark scaled to `share` of a `size` square, centred on the cream surface. */
async function onSurface(size, share, file, dir = OUT) {
  const inner = Math.round(size * share);
  const mark = await sharp(MARK).resize(inner, inner, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: CREAM } })
    .composite([{ input: mark, gravity: "centre" }])
    .png()
    .toFile(join(dir, file));
}

// `app/icon.png` already carries its own margin (the mark spans about 62% of it), so `share` is the
// size of that whole image relative to the icon, not of the mark itself.
await onSurface(192, 1, "icon-192.png");
await onSurface(512, 1, "icon-512.png");
// The maskable safe zone is the centre circle of 80% diameter; at 0.85 the mark spans about 53%.
await onSurface(512, 0.85, "maskable-512.png");
await onSurface(180, 1, "apple-icon.png", join(app, "app"));

// The badge: every pixel white, the mark's own alpha kept, on a transparent square.
const size = 96;
const alpha = await sharp(MARK).resize(size, size).extractChannel("alpha").toBuffer();
await sharp({ create: { width: size, height: size, channels: 3, background: { r: 255, g: 255, b: 255 } } })
  .joinChannel(alpha)
  .png()
  .toFile(join(OUT, "badge-96.png"));

console.log(`icons written to ${OUT}`);
