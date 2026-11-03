/**
 * The interface's style: Ruchoir, or one of four flat styles (see the design system's `tokens.css`,
 * "Simplified styles"). Kept free of React so Node tests it. Per device, like the accent: it is not
 * an account setting (see `accountPrefs.ts`).
 */

export type AppStyle = "ruchoir" | "aubergine" | "nuage" | "indigo" | "marine";

/** The styles, in the order the Preferences screen shows them. */
export const APP_STYLES: AppStyle[] = ["ruchoir", "aubergine", "nuage", "indigo", "marine"];

/** A stored style read back: anything that is not one of them is the Ruchoir style. */
export function storedStyle(value: unknown): AppStyle {
  return typeof value === "string" && (APP_STYLES as string[]).includes(value) ? (value as AppStyle) : "ruchoir";
}

/** What `data-style` on <html> carries: nothing for the Ruchoir style (the bare :root), else the name. */
export function styleAttr(style: AppStyle): string | undefined {
  return style === "ruchoir" ? undefined : style;
}
