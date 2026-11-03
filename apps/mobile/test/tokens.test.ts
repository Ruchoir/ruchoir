// Run with `pnpm --filter @ruchoir/mobile test` (Node's own runner, types stripped by Node).
// The app cannot read CSS, so its palette is a copy: this keeps the copy honest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { resolveTokens, VARIANTS as CSS_VARIANTS } from "../../../packages/design-system/test/resolve.mjs";
import { ACCENTS, PALETTE_KEYS, palette, semantic, SHAPES, STYLES, themeName, tokens, VARIANTS } from "../src/theme/tokens.ts";

const css = readFileSync(new URL("../../../packages/design-system/styles/tokens.css", import.meta.url), "utf8");

/** The custom properties declared directly in the block that opens with `selector {`. */
function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `no ${selector} block in tokens.css`);
  const body = css.slice(start, css.indexOf("\n}", start));
  const vars: Record<string, string> = {};
  for (const m of body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) vars[m[1]] = m[2].trim();
  return vars;
}

/** `--line-strong` for `lineStrong`. */
const cssName = (key: string) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

function resolve(vars: Record<string, string>, key: string): string {
  let value = vars[cssName(key)];
  for (let i = 0; value?.startsWith("var(") && i < 5; i++) value = vars[value.slice(6, -1)];
  return value;
}

const root = block(":root");
const violet = { ...root, ...block('[data-theme^="violet"]') };
const violetDark = { ...violet, ...block('[data-theme$="-dark"]') };

test("light_palette_matches_tokens_css", () => {
  for (const key of PALETTE_KEYS) assert.equal(tokens.violet[key], resolve(violet, key), key);
});

test("dark_palette_matches_tokens_css", () => {
  for (const key of PALETTE_KEYS) assert.equal(tokens["violet-dark"][key], resolve(violetDark, key), key);
});

test("every_accent_by_day_and_by_night_matches_tokens_css", () => {
  for (const accent of ACCENTS) {
    // Sky is the bare :root; the other accents only swap `--acc`.
    const day = accent === "sky" ? root : { ...root, ...block(`[data-theme^="${accent}"]`) };
    const night = { ...day, ...block('[data-theme$="-dark"]') };
    for (const key of PALETTE_KEYS) {
      assert.equal(tokens[themeName(accent, false)][key], resolve(day, key), `${accent} ${key}`);
      assert.equal(tokens[themeName(accent, true)][key], resolve(night, key), `${accent}-dark ${key}`);
    }
  }
});

// --- The simplified styles (lot 4) ----------------------------------------------------------------


/** `rgb(r g b / a)` laid over a hex colour, as hex; a hex colour as it is. */
function flatten(value: string, under: string): string {
  const m = value.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*[/,]\s*([\d.]+)\s*\)$/);
  if (!m) return value;
  const a = Number(m[4]);
  const u = [1, 3, 5].map((i) => parseInt(under.slice(i, i + 2), 16));
  return `#${[1, 2, 3].map((i, k) => Math.round(Number(m[i]) * a + u[k] * (1 - a)).toString(16).padStart(2, "0")).join("")}`;
}

const px = (value: string) => (value === "999px" ? 999 : Number(value.replace("px", "")));
const VARIANT_PALETTE = ["bg", "surface", "line", "lineStrong", "controlLine", "ink", "body", "muted", "acc"] as const;

test("the_mobile_styles_are_the_webs", () => {
  assert.deepEqual(STYLES, ["ruchoir", ...CSS_VARIANTS]);
  assert.deepEqual(VARIANTS, CSS_VARIANTS);
});

test("every_variant_by_day_and_by_night_matches_tokens_css", () => {
  for (const v of VARIANTS) {
    for (const night of [false, true]) {
      const t = resolveTokens(css, v, night) as Record<string, string>;
      const rail = resolveTokens(css, v, night, "rail") as Record<string, string>;
      const where = `${v}${night ? " night" : ""}`;
      for (const accent of ACCENTS) {
        const p = palette(v, accent, night);
        for (const key of VARIANT_PALETTE) assert.equal(p[key], t[`--${cssName(key)}`], `${where} ${key}`);
        const s = semantic(p, night, v);
        const expected = {
          primary: t["--action-primary-bg"],
          onPrimary: t["--action-primary-fg"],
          link: t["--text-link"],
          mention: t["--surface-mention"],
          badge: t["--badge-bg"],
          onBadge: t["--badge-fg"],
          edge: t["--edge-float"],
          focus: t["--edge-focus"],
          bar: t["--rail-bg"],
          barMuted: flatten(rail["--text-muted"], t["--rail-bg"]),
          msgBg: t["--msg-bg"] === "transparent" ? null : t["--msg-bg"],
          msgEdge: t["--msg-edge"] === "none" ? null : t["--msg-edge"].split(" ").pop(),
          shadow: "transparent",
        };
        for (const [key, value] of Object.entries(expected)) assert.equal(s[key as keyof typeof s], value, `${where} ${key}`);
      }
    }
  }
});

test("every_variants_shape_matches_tokens_css", () => {
  for (const v of VARIANTS) {
    const t = resolveTokens(css, v, false) as Record<string, string>;
    const shape = SHAPES[v];
    assert.deepEqual(shape.radius, { s: px(t["--radius-sm"]), m: px(t["--radius-md"]), l: px(t["--radius-lg"]) }, v);
    assert.equal(shape.control, px(t["--radius-control"]), `${v} control`);
    assert.equal(shape.hairline, px(t["--border-width"]), `${v} hairline`);
    assert.equal(shape.edgeWidth, px(t["--edge-width"]), `${v} edgeWidth`);
    assert.equal(shape.flat, true, `${v} flat`);
    const avatar = t["--avatar-radius"] === "999px" ? 20 : px(t["--avatar-radius"]);
    assert.equal(shape.avatar(40), avatar, `${v} avatar`);
    assert.equal(shape.msg.padTop, px(t["--msg-pad-top"]), `${v} msg.padTop`);
    assert.equal(shape.msg.padTopGrouped, px(t["--msg-pad-top-grouped"]), `${v} msg.padTopGrouped`);
    assert.equal(shape.msg.space, px(t["--msg-space"]), `${v} msg.space`);
    assert.equal(shape.msg.padX, 16, `${v} msg.padX`);
    assert.equal(shape.msg.card, t["--msg-bg"] !== "transparent", `${v} msg.card`);
  }
});

test("the_ruchoir_style_is_todays_theme", () => {
  for (const accent of ACCENTS) {
    for (const dark of [false, true]) {
      const p = palette("ruchoir", accent, dark);
      assert.equal(p, tokens[themeName(accent, dark)]);
      const s = semantic(p, dark, "ruchoir");
      assert.deepEqual(semantic(p, dark), s);
      assert.equal(s.primary, p.ink);
      assert.equal(s.badge, p.ink);
      assert.equal(s.onPrimary, p.onInk);
      assert.equal(s.onBadge, p.onInk);
      assert.equal(s.edge, p.ink);
      assert.equal(s.focus, p.ink);
      assert.equal(s.bar, p.surface);
      assert.equal(s.barFg, p.ink);
      assert.equal(s.barMuted, p.muted);
      assert.equal(s.msgBg, null);
      assert.equal(s.msgEdge, null);
      assert.equal(s.shadow, dark ? "#000000" : p.ink);
    }
  }
  const { avatar, ...rest } = SHAPES.ruchoir;
  assert.deepEqual(rest, {
    radius: { s: 6, m: 10, l: 16 },
    control: 10,
    hairline: 1.5,
    edgeWidth: 2,
    flat: false,
    msg: { padTop: 10, padTopGrouped: 2, padX: 16, space: 0, card: false },
  });
  assert.equal(avatar(32), 10);
  assert.equal(avatar(24), 6);
});
