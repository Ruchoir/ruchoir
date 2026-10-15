import type { CSSProperties } from "react";

/**
 * The flag for a language, worked out rather than listed.
 *
 * Two earlier attempts were worse. Emoji flags looked right on the machine they were written on and
 * nowhere else: Chrome and Edge on Windows carry no flag glyphs and fall back to two regional
 * letters. Six flags drawn by hand fixed that but had to be extended by hand too, so a seventh
 * language would have arrived with no flag and nothing to say so.
 *
 * This asks the runtime instead. `Intl.Locale.maximize()` answers "which region does this language
 * most likely belong to" (`pl` → `PL`, `de` → `DE`), which is exactly the question, and the flag
 * comes from `flag-icons` (MIT, European authorship, bundled with the app: a self-hosted instance
 * still makes no outside request). Any language the product gains from here on has its flag already.
 *
 * A flag is a country and a language is not, which the menu answers by naming each language in
 * itself beside it: the flag is the icon people aim at, the name is what it means.
 */

/**
 * Where the runtime's guess is wrong for this product.
 *
 * `en` maximizes to `US`, which is defensible arithmetic and the wrong flag for a European product
 * whose English is the one spoken next door. One entry, so the exception stays visible.
 */
const REGION_OVERRIDES: Record<string, string> = { en: "GB" };

/** The region a language tag belongs to, lower-cased for `flag-icons`, or `null` if unknown. */
export function regionForLocale(tag: string): string | null {
  const primary = tag.toLowerCase().split(/[-_]/)[0];
  if (REGION_OVERRIDES[primary]) return REGION_OVERRIDES[primary].toLowerCase();
  try {
    const region = new Intl.Locale(tag).maximize().region;
    return region ? region.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * One flag, `size` being its width.
 *
 * Presentational: it never carries the meaning on its own, so it is hidden from assistive
 * technology and the language's name is what is read out.
 */
export function Flag({ locale, size = 20, style }: { locale: string; size?: number; style?: CSSProperties }) {
  const region = regionForLocale(locale);
  const box: CSSProperties = {
    width: size,
    height: Math.round((size * 3) / 4),
    flex: "none",
    borderRadius: 2,
    // Pale flags (Poland's lower half, Japan's field) would dissolve into a light background: a
    // hairline keeps the shape without drawing attention to itself.
    boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--text-default) 18%, transparent)",
    ...style,
  };
  // No region: a blank of the same size, so a menu of languages keeps its columns aligned rather
  // than having one row start further left than the others.
  if (!region) return <span aria-hidden style={{ ...box, boxShadow: "none" }} />;
  return <span aria-hidden className={`fi fi-${region}`} style={box} />;
}
