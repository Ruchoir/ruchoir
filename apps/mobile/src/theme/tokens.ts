/**
 * Ruchoir's design tokens for the app.
 *
 * A copy of the palette of `packages/design-system/styles/tokens.css`, the one source of the design system's colours:
 * React Native cannot read CSS, so the values are repeated here and `test/tokens.test.ts` fails the
 * moment the two disagree. The four accents of the web, by day and by night; violet, the one the
 * mockups are drawn in, is the default.
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
/** The accents a person chooses among, as on the web. */
export type Accent = "sky" | "mint" | "violet" | "pink";
export const ACCENTS: Accent[] = ["sky", "mint", "violet", "pink"];
export type ThemeName = Accent | `${Accent}-dark`;

export function themeName(accent: Accent, dark: boolean): ThemeName {
  return dark ? `${accent}-dark` : accent;
}

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

/** The neutrals of a day screen and of a night screen; the accent is laid over them. */
const DAY = {
  ...PASTELS,
  bg: "#f6f7f9",
  surface: "#fdfdfe",
  line: "#e2e5ea",
  lineStrong: "#cfd3da",
  controlLine: "#7d8391",
  ink: "#15171c",
  body: "#2e323a",
  muted: "#5a6070",
  onInk: "#ffffff",
};
const NIGHT = {
  ...PASTELS,
  bg: "#15171c",
  surface: "#1d2027",
  line: "#2e323a",
  lineStrong: "#3f4450",
  controlLine: "#7d8391",
  ink: "#f6f7f9",
  body: "#dfe2e7",
  muted: "#a7adb8",
  onInk: "#15171c",
};

export const tokens = Object.fromEntries(
  ACCENTS.flatMap((accent) => [
    [themeName(accent, false), { ...DAY, acc: PASTELS[accent] }],
    [themeName(accent, true), { ...NIGHT, acc: PASTELS[accent] }],
  ]),
) as Record<ThemeName, Palette>;

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
    /** `--surface-sunken` (`--grey-50`): the well a server row or a segmented control sits in. */
    sunken: dark ? "#23262e" : "#eef0f3",
    /** `--text-link`: the accent deepened towards the ink by day, the accent itself by night. */
    link: dark ? p.acc : mix(p.acc, p.ink, 0.4),
    disabledText: dark ? "#6b717d" : "#9aa1ad",
    /** `--action-ghost-bg-active`. */
    pressed: dark ? "#ffffff1c" : "#15171c1a",
    danger: dark ? p.peach : "#c2303f",
    dangerBg: mix(p.peach, p.surface, dark ? 0.14 : 0.25),
    success: dark ? p.mint : p.mintInk,
    successBg: mix(p.mint, p.surface, dark ? 0.14 : 0.18),
    shadow: dark ? "#000000" : p.ink,
    scrim: dark ? "rgba(0,0,0,0.66)" : "rgba(21,23,28,0.45)",
  };
}
