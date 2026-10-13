/**
 * Ruchoir's design tokens for the app.
 *
 * A copy of the palette of `apps/web/app/tokens.css`, the one source of the design system's colours:
 * React Native cannot read CSS, so the values are repeated here and `test/tokens.test.ts` fails the
 * moment the two disagree. Only the violet accent ships in step 1 (the one the mockups are drawn
 * in); the other accents arrive with the preferences screen.
 *
 * Kept free of React Native imports so Node's test runner can load it.
 */

export const PALETTE_KEYS = [
  "bg",
  "surface",
  "line",
  "lineStrong",
  "controlLine",
  "ink",
  "body",
  "muted",
  "sky",
  "mint",
  "violet",
  "pink",
  "peach",
  "lime",
  "sun",
  "mintInk",
  "peachInk",
  "sunInk",
  "bee",
  "alarm",
  "brand",
  "acc",
  "onPastel",
  "onInk",
] as const;

export type PaletteKey = (typeof PALETTE_KEYS)[number];
export type Palette = Record<PaletteKey, string>;
export type ThemeName = "violet" | "violet-dark";

/** The pastels and reserved colours, identical by day and by night. */
const PASTELS = {
  sky: "#8fd0ff",
  mint: "#6fe0c2",
  violet: "#c9a8ff",
  pink: "#f5b0f0",
  peach: "#ffb3ba",
  lime: "#8fe6a3",
  sun: "#ffd84d",
  mintInk: "#0c5a47",
  peachInk: "#7a1d27",
  sunInk: "#5b4300",
  bee: "#fbbf1a",
  alarm: "#f4522a",
  brand: "#c65d45",
  onPastel: "#15171c",
};

export const tokens: Record<ThemeName, Palette> = {
  violet: {
    ...PASTELS,
    bg: "#f6f7f9",
    surface: "#fdfdfe",
    line: "#e2e5ea",
    lineStrong: "#cfd3da",
    controlLine: "#7d8391",
    ink: "#15171c",
    body: "#2e323a",
    muted: "#5a6070",
    acc: PASTELS.violet,
    onInk: "#ffffff",
  },
  "violet-dark": {
    ...PASTELS,
    bg: "#15171c",
    surface: "#1d2027",
    line: "#2e323a",
    lineStrong: "#3f4450",
    controlLine: "#7d8391",
    ink: "#f6f7f9",
    body: "#dfe2e7",
    muted: "#a7adb8",
    acc: PASTELS.violet,
    onInk: "#15171c",
  },
};

/** The design system's three radii and its hairline. */
export const radius = { s: 6, m: 10, l: 16 } as const;
export const hairline = 1.5;

/** `color-mix(in srgb, a weight%, b)`, for the few tints the web derives the same way. */
export function mix(a: string, b: string, weight: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  const channel = (i: number) => Math.round(ca[i] * weight + cb[i] * (1 - weight));
  return `#${[0, 1, 2].map((i) => channel(i).toString(16).padStart(2, "0")).join("")}`;
}

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/**
 * The derived colours the screens use, computed as `tokens.css` computes them: what is selected and
 * what mentions you are tinted with the accent; danger is the deep red by day, the peach by night.
 */
export function semantic(p: Palette, dark: boolean) {
  return {
    selected: mix(p.acc, p.surface, 0.22),
    mention: mix(p.acc, p.bg, 0.12),
    accSoft: mix(p.acc, p.surface, 0.45),
    danger: dark ? p.peach : "#c2303f",
    success: dark ? p.mint : p.mintInk,
    shadow: dark ? "#000000" : p.ink,
  };
}
