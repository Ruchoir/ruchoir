# Self-hosted fonts

Sovereignty rule: Ruchoir never loads fonts from Google Fonts or any external CDN
(see `AGENTS.md`). The UI uses **IBM Plex Sans** and **IBM Plex Mono**, both under the SIL Open
Font License (OFL, see `OFL.txt`), served from this folder.

The committed woff2 files are the **latin subset**, static per weight. The latin subset covers
French in full (all accented letters live in Latin-1), which keeps the payload small:

- `ibm-plex-sans-latin-{400,500,600,700}-normal.woff2`
- `ibm-plex-mono-latin-{400,500,600}-normal.woff2`

The matching `@font-face` rules are in `../styles/fonts.css` (one per weight). Add a weight or the
`latin-ext` subset only if a glyph turns up missing.

Provenance: the OFL binaries as repackaged by Fontsource's `@fontsource/ibm-plex-sans` and
`@fontsource/ibm-plex-mono` (identical to the official IBM Plex release). The OFL permits
redistribution, so these are committed directly. Do not fetch fonts at build time or runtime.

## OpenDyslexic (accessibility option)

The appearance settings offer **OpenDyslexic** as a dyslexia-friendly typeface (also OFL, so it is
self-hosted here exactly like IBM Plex). Its `@font-face` rules are in `../styles/fonts.css`,
expecting these two OpenType files in this folder:

- `opendyslexic-400-normal.otf` (Regular)
- `opendyslexic-700-normal.otf` (Bold)

The upstream release ships as OTF, which browsers load natively (`format("opentype")`), so committing
the `.otf` directly is fine. The font is only fetched when a user actually selects "OpenDyslexic", so
the larger OTF payload stays on-demand. If you later want a smaller, subset payload, convert to woff2
(e.g. `fonttools` / `woff2`) and switch the two `src` lines back to `format("woff2")`.

The Regular and Bold OTF files are committed here, with the upstream attribution kept alongside in
`opendyslexic-README.txt` (OpenDyslexic is OFL, based on Bitstream Vera). Source: opendyslexic.org.
Same rule as above: commit the font directly, never fetch at build or runtime.
