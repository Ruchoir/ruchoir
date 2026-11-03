/**
 * The simplified styles as the cascade draws them on `<html>`, read from `styles/tokens.css`, and
 * the contrast of two of their colours. Shared by this package's tests and by the web app's
 * screenshot tool (which reads `VARIANTS`).
 */
import { blockDeclarations } from "./styleTokens.mjs";

/** The four simplified styles, in the order the Preferences screen lists them. */
export const VARIANTS = ["aubergine", "nuage", "indigo", "marine"];

const NIGHT = '[data-theme$="-dark"]';
/** The flat layer, shared by the four. */
export const FLAT = "[data-style]";
/** What floats inside a pane takes the content's values back. */
export const RESTORE = "[data-style] :is(.wc-pane-sidebar, .wc-pane-rail) :is(.wc-float, .wc-pop, .wc-dlg, .wc-sheet, .wc-inp)";

export const shapeSelector = (v) => `[data-style="${v}"]`;
export const colourSelector = (v, night) => `[data-style="${v}"]${night ? NIGHT : `:not(${NIGHT})`}`;
export const paneSelector = (v, night, pane) => `${colourSelector(v, night)} .wc-pane-${pane}`;

/** Replace every `var(--x[, fallback])` in each value with what it names, as far as it goes. */
function resolveAll(map) {
  const out = {};
  const resolve = (value, depth) => {
    if (depth > 20) return value;
    return value.replace(/var\((--[a-z0-9-]+)(?:\s*,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/g, (whole, name, fallback) => {
      if (name in map) return resolve(map[name], depth + 1);
      return fallback !== undefined ? resolve(fallback.trim(), depth + 1) : whole;
    });
  };
  for (const [name, value] of Object.entries(map)) out[name] = resolve(value, 0);
  return out;
}

/**
 * The tokens of a variant, by day or by night, with every `var()` resolved: the bare `:root`, the
 * night block, the flat layer, the variant's shape and the colours of the mode, in that order, all
 * on the same element. With `pane`, the pane's own block is laid over those resolved values.
 */
export function resolveTokens(css, variant, night, pane) {
  const layers = [":root", night ? NIGHT : null, FLAT, shapeSelector(variant), colourSelector(variant, night)];
  const root = resolveAll(Object.assign({}, ...layers.filter(Boolean).map((s) => blockDeclarations(css, s))));
  if (!pane) return root;
  return resolveAll({ ...root, ...blockDeclarations(css, paneSelector(variant, night, pane)) });
}

/** `#rgb`, `#rrggbb`, `rgb(r g b)` or `rgb(r g b / a)` as [r, g, b, a], or null. */
function parse(value) {
  const v = value.trim().toLowerCase();
  let m = v.match(/^#([0-9a-f]{3})$/);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16)).concat(1);
  m = v.match(/^#([0-9a-f]{6})$/);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(1);
  m = v.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[/,]\s*([\d.]+)(%?))?\s*\)$/);
  if (m) {
    const a = m[4] === undefined ? 1 : Number(m[4]) / (m[5] ? 100 : 1);
    return [Number(m[1]), Number(m[2]), Number(m[3]), a];
  }
  return null;
}

const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);

function luminance([r, g, b]) {
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * The contrast ratio of `fg` on `bg` (token names), `bg` laid over `base` when given. A translucent
 * colour is composited over what it sits on. Returns a message naming the token when a colour
 * cannot be measured (a `color-mix`, a name nothing declares, a translucent colour over nothing).
 */
export function contrast(tokens, fg, bg, base) {
  const read = (name) => {
    const value = tokens[name];
    const c = value === undefined ? null : parse(value);
    return c ?? `cannot measure ${name} (${value ?? "not declared"})`;
  };
  let back = read(bg);
  if (typeof back === "string") return back;
  if (back[3] < 1) {
    if (!base) return `cannot measure ${bg}: translucent over nothing`;
    const under = read(base);
    if (typeof under === "string") return under;
    if (under[3] < 1) return `cannot measure ${base}: translucent`;
    back = over(back, under);
  }
  let front = read(fg);
  if (typeof front === "string") return front;
  if (front[3] < 1) front = over(front, back);
  const [a, b] = [luminance(front), luminance(back)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}
