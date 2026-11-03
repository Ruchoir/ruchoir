/**
 * The tokens a style may override (see `styles/tokens.css`), with the value each one has in the
 * Ruchoir style. They replaced literals one for one, so these defaults are the literals' values
 * (the label face excepted: the interface face since 2026-11-03, where it was the monospace one).
 * Shared by this package's test and by the web app's, which checks its own files use only these.
 */
export const STYLE_TOKENS = {
  "--shadow-lift-sm": "3px 3px 0 var(--bee)",
  "--shadow-lift-lg": "8px 8px 0 var(--bee)",
  "--shadow-accent": "4px 4px 0 var(--acc)",
  "--shadow-editing": "4px 4px 0 var(--peach)",
  "--shadow-ring-offset": "0 0 0 2px var(--ink), 3px 3px 0 2px var(--ink)",
  "--shadow-ring-offset-sm": "0 0 0 1.5px var(--ink), 2px 2px 0 1.5px var(--ink)",
  "--lift": "translate(-2px, -2px)",
  "--lift-sm": "translate(-1px, -1px)",
  "--lift-y-sm": "translateY(-1px)",
  "--press": "translate(3px, 3px)",
  "--edge-float": "var(--ink)",
  "--edge-focus": "var(--ink)",
  "--label-font": "var(--font-sans)",
  "--sidebar-bg": "var(--surface-chrome)",
  "--sidebar-selected-bg": "var(--acc)",
  "--sidebar-selected-fg": "var(--on-pastel)",
  "--rail-bg": "var(--surface-canvas)",
  "--msg-gap": "14px",
  "--msg-pad-x": "8px",
  "--msg-pad-top": "6px",
  "--msg-pad-top-grouped": "2px",
  "--avatar-radius": "var(--radius-sm)",
  "--radius-control": "var(--radius-md)",
  "--radius-item": "var(--radius-sm)",
  "--radius-space": "var(--radius-md)",
  "--radius-msg": "var(--radius-md)",
  "--edge-width": "2px",
  "--badge-bg": "var(--action-primary-bg)",
  "--badge-fg": "var(--action-primary-fg)",
  "--tilt": "rotate(-6deg) scale(1.06)",
  "--tilt-icon": "scale(1.15) rotate(-6deg)",
  "--sidebar-selected-mark": "none",
  "--msg-bg": "transparent",
  "--msg-edge": "none",
  "--msg-space": "0px",
};

/** The declarations of the first block opened by `selector` in `css`, as a name to value map. */
export function blockDeclarations(css, selector) {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) return {};
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("\n}", start));
  const out = {};
  for (const m of body.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out[m[1]] = m[2].replace(/\s+/g, " ").trim();
  }
  return out;
}

/** Every custom property a stylesheet or a source file reads through `var(--name)`. */
export function readTokens(source) {
  return new Set([...source.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
}
