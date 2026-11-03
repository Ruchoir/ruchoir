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

/** The design system's three radii and its hairline, as the Ruchoir style draws them. */
export const radius = { s: 6, m: 10, l: 16 } as const;
export const hairline = 1.5;

/**
 * The styles a person chooses among, as on the web (`data-style`): Ruchoir, or one of four flat
 * ones. The order is the Preferences screen's.
 */
export type Style = "ruchoir" | "aubergine" | "nuage" | "indigo" | "marine";
export type Variant = Exclude<Style, "ruchoir">;
export const VARIANTS: Variant[] = ["aubergine", "nuage", "indigo", "marine"];
export const STYLES: Style[] = ["ruchoir", ...VARIANTS];

/** What a style changes besides colours: corners, lines, depth, the faces' corners, messages. */
export type Shape = {
  radius: { s: number; m: number; l: number };
  /** A button's or a field's corner (`--radius-control`). */
  control: number;
  /** The thin line of a card or a field (`--border-width`). */
  hairline: number;
  /** The width of an ink edge: a floating card, the composer (`--edge-width`). */
  edgeWidth: number;
  /** No offset shadow, no lift, no nudge when pressed. */
  flat: boolean;
  /** A face's corner at a given size (`--avatar-radius`). */
  avatar: (size: number) => number;
  /** A message row: space above it (alone or continuing), at its sides, between cards, as a card. */
  msg: { padTop: number; padTopGrouped: number; padX: number; space: number; card: boolean };
};

const round = (size: number) => size / 2;
const msg = (padTop: number, padTopGrouped: number, space: number, card = false) => ({ padTop, padTopGrouped, padX: 16, space, card });

/** Copies of the shapes of `tokens.css` (`test/tokens.test.ts` keeps them honest). */
export const SHAPES: Record<Style, Shape> = {
  ruchoir: {
    radius,
    control: radius.m,
    hairline,
    edgeWidth: 2,
    flat: false,
    avatar: (size) => (size >= 32 ? radius.m : radius.s),
    msg: msg(10, 2, 0),
  },
  aubergine: { radius: { s: 4, m: 6, l: 8 }, control: 4, hairline: 1, edgeWidth: 1, flat: true, avatar: () => 6, msg: msg(6, 2, 0) },
  nuage: { radius: { s: 8, m: 16, l: 16 }, control: 999, hairline: 1, edgeWidth: 1, flat: true, avatar: round, msg: msg(8, 4, 6) },
  indigo: { radius: { s: 4, m: 6, l: 8 }, control: 4, hairline: 1, edgeWidth: 1, flat: true, avatar: round, msg: msg(8, 4, 8, true) },
  marine: { radius: { s: 4, m: 4, l: 4 }, control: 4, hairline: 1, edgeWidth: 1, flat: true, avatar: round, msg: msg(5, 1, 0) },
};

type Hex = `#${string}`;
/** What a variant replaces in the palette, and the colours it gives what the screens derive. */
type VariantColours = {
  bg: Hex; surface: Hex; line: Hex; lineStrong: Hex; controlLine: Hex; ink: Hex; body: Hex; muted: Hex; acc: Hex;
  primary: Hex; onPrimary: Hex; link: Hex; mention: Hex; badge: Hex; onBadge: Hex; edge: Hex; focus: Hex;
  /** The tab bar and the tablet's rail: the web's band of spaces. */
  bar: Hex; barFg: Hex; barMuted: Hex;
  /** Indigo's message card and its edge; null where messages sit on the page. */
  msgBg: Hex | null; msgEdge: Hex | null;
};

/**
 * Copies of the four variants of `tokens.css`, by day and by night, as `resolve.mjs` resolves them
 * (`test/tokens.test.ts` fails the moment the two disagree, `test/styleContrast.test.ts` when a text
 * stops being readable). `barMuted` is the rail's muted text laid over the bar.
 */
const VARIANT_COLOURS: Record<Variant, { day: VariantColours; night: VariantColours }> = {
  aubergine: {
    day: {
      bg: "#ffffff", surface: "#ffffff", line: "#e2e2e2", lineStrong: "#d6d6d6", controlLine: "#868686",
      ink: "#1d1c1d", body: "#1d1c1d", muted: "#616061", acc: "#b9d7f0",
      primary: "#007a5a", onPrimary: "#ffffff", link: "#1264a3", mention: "#fdf4e3", badge: "#cd2553", onBadge: "#ffffff",
      edge: "#d6d6d6", focus: "#1264a3", bar: "#3a0e3b", barFg: "#ffffff", barMuted: "#c6b3c7", msgBg: null, msgEdge: null,
    },
    night: {
      bg: "#1a1d21", surface: "#222529", line: "#35373b", lineStrong: "#3c3e42", controlLine: "#6e6e6e",
      ink: "#f2f2f2", body: "#d1d2d3", muted: "#9a9b9e", acc: "#b9d7f0",
      primary: "#007a5a", onPrimary: "#ffffff", link: "#4ea4e8", mention: "#3a3220", badge: "#cd2553", onBadge: "#ffffff",
      edge: "#3c3e42", focus: "#4ea4e8", bar: "#121016", barFg: "#ffffff", barMuted: "#9a9b9e", msgBg: null, msgEdge: null,
    },
  },
  nuage: {
    day: {
      bg: "#ffffff", surface: "#ffffff", line: "#ededed", lineStrong: "#dbdbdb", controlLine: "#8a8a8a",
      ink: "#222222", body: "#222222", muted: "#6b6b6b", acc: "#b3dcf3",
      primary: "#0073b1", onPrimary: "#ffffff", link: "#00679e", mention: "#eaf5fb", badge: "#0073b1", onBadge: "#ffffff",
      edge: "#dbdbdb", focus: "#00679e", bar: "#0073b1", barFg: "#ffffff", barMuted: "#ffffff", msgBg: null, msgEdge: null,
    },
    night: {
      bg: "#171717", surface: "#222222", line: "#2a2a2a", lineStrong: "#3d3d3d", controlLine: "#707070",
      ink: "#ffffff", body: "#e6e6e6", muted: "#a8a8a8", acc: "#b3dcf3",
      primary: "#2a9de0", onPrimary: "#111111", link: "#55b6ec", mention: "#13293a", badge: "#2a9de0", onBadge: "#111111",
      edge: "#3d3d3d", focus: "#55b6ec", bar: "#00507c", barFg: "#ffffff", barMuted: "#ffffff", msgBg: null, msgEdge: null,
    },
  },
  indigo: {
    day: {
      bg: "#f5f5f5", surface: "#ffffff", line: "#e0e0e0", lineStrong: "#d1d1d1", controlLine: "#858585",
      ink: "#242424", body: "#242424", muted: "#616161", acc: "#c5c8f5",
      primary: "#5b5fc7", onPrimary: "#ffffff", link: "#4f52b2", mention: "#e8ebfa", badge: "#c4314b", onBadge: "#ffffff",
      edge: "#d1d1d1", focus: "#4f52b2", bar: "#ebebeb", barFg: "#242424", barMuted: "#616161", msgBg: "#ffffff", msgEdge: "#e6e6e6",
    },
    night: {
      bg: "#1f1f1f", surface: "#292929", line: "#3d3d3d", lineStrong: "#4a4a4a", controlLine: "#727272",
      ink: "#ffffff", body: "#d6d6d6", muted: "#adadad", acc: "#c5c8f5",
      primary: "#7f85f5", onPrimary: "#141414", link: "#9ea2ff", mention: "#2a2c4d", badge: "#c4314b", onBadge: "#ffffff",
      edge: "#4a4a4a", focus: "#9ea2ff", bar: "#141414", barFg: "#ffffff", barMuted: "#adadad", msgBg: "#292929", msgEdge: "#333333",
    },
  },
  marine: {
    day: {
      bg: "#ffffff", surface: "#ffffff", line: "#e3e4e8", lineStrong: "#d5d7dc", controlLine: "#868686",
      ink: "#2a2d36", body: "#3f4350", muted: "#6b6f7a", acc: "#b8cdf6",
      primary: "#1c58d9", onPrimary: "#ffffff", link: "#1c58d9", mention: "#fff8e0", badge: "#1c58d9", onBadge: "#ffffff",
      edge: "#d5d7dc", focus: "#1c58d9", bar: "#14213e", barFg: "#ffffff", barMuted: "#a1a6b2", msgBg: null, msgEdge: null,
    },
    night: {
      bg: "#191b1f", surface: "#202228", line: "#30333a", lineStrong: "#3a3d44", controlLine: "#6b7080",
      ink: "#ffffff", body: "#dddfe4", muted: "#a3a6ad", acc: "#b8cdf6",
      primary: "#3d6fdc", onPrimary: "#ffffff", link: "#6d9af0", mention: "#33301c", badge: "#3d6fdc", onBadge: "#ffffff",
      edge: "#3a3d44", focus: "#6d9af0", bar: "#121317", barFg: "#ffffff", barMuted: "#949597", msgBg: null, msgEdge: null,
    },
  },
};

const PALETTE_OVERRIDES = ["bg", "surface", "line", "lineStrong", "controlLine", "ink", "body", "muted", "acc"] as const;

/** One palette per (style, accent, night): Ruchoir's is the accent's; a variant brings its own. */
const VARIANT_PALETTES = Object.fromEntries(
  VARIANTS.flatMap((v) =>
    [false, true].map((dark) => {
      const colours = VARIANT_COLOURS[v][dark ? "night" : "day"];
      const base = tokens[themeName("sky", dark)];
      const own = Object.fromEntries(PALETTE_OVERRIDES.map((key) => [key, colours[key]]));
      return [`${v}${dark ? "-dark" : ""}`, { ...base, ...own } as Palette];
    }),
  ),
) as Record<string, Palette>;

/** The palette of a style, an accent and a mode. A variant ignores the accent (it stays stored). */
export function palette(style: Style, accent: Accent, dark: boolean): Palette {
  if (style === "ruchoir") return tokens[themeName(accent, dark)];
  return VARIANT_PALETTES[`${style}${dark ? "-dark" : ""}`];
}

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
 * A variant gives its own link, mention, primary action, badge, edges, bar and message card, and
 * draws no shadow.
 */
export function semantic(p: Palette, dark: boolean, style: Style = "ruchoir") {
  const base = {
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
    /** `--action-primary-bg` / `-fg`: the ink in Ruchoir. */
    primary: p.ink,
    onPrimary: p.onInk,
    /** `--badge-bg` / `-fg`: an unread count. */
    badge: p.ink,
    onBadge: p.onInk,
    /** `--edge-float`: the edge of what floats or is outlined (the ink in Ruchoir, a grey when flat). */
    edge: p.ink,
    /** `--edge-focus`. */
    focus: p.ink,
    /** The tab bar and the tablet's rail, its active and its resting labels. */
    bar: p.surface,
    barFg: p.ink,
    barMuted: p.muted,
    /** A message's card and its edge (Indigo); null where messages sit on the page. */
    msgBg: null as string | null,
    msgEdge: null as string | null,
  };
  if (style === "ruchoir") return base;
  const v = VARIANT_COLOURS[style][dark ? "night" : "day"];
  return {
    ...base,
    link: v.link,
    mention: v.mention,
    primary: v.primary,
    onPrimary: v.onPrimary,
    badge: v.badge,
    onBadge: v.onBadge,
    edge: v.edge,
    focus: v.focus,
    bar: v.bar,
    barFg: v.barFg,
    barMuted: v.barMuted,
    msgBg: v.msgBg,
    msgEdge: v.msgEdge,
    shadow: "transparent",
  };
}
