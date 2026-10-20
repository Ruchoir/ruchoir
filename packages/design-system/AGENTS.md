# AGENTS.md - packages/design-system

`@ruchoir/design-system`: Ruchoir's design system as a package. Design tokens, typefaces, and the
React components with their stylesheet, recreated from the Claude Design handoff. Used by the web
app (`apps/web`, through the workspace) and by Ruchoir Lab (a separate repository, through a git
dependency pinned to a tag). See root `AGENTS.md` for project-wide rules.

## Layout

```
src/        the components (Button, Tag, Tabs, Dialog, Avatar...), index.ts re-exports them all;
            avatarImage.ts (generated avatars; not `avatar.ts`, which a case-insensitive disk takes
            for `Avatar.tsx`) and haptics.ts (a tap under the finger) beside them
styles/     tokens.css (palette, semantic tokens, the eight themes), fonts.css (@font-face and
            --font-sans / --font-mono), components.css (the `wc-*` classes), index.css (all of it,
            plus the flag-icons stylesheet `Flag` reads)
fonts/      IBM Plex Sans and Mono, OpenDyslexic (OFL, self-hosted, see the README there)
```

Entry points (`package.json` `exports`): `.` (the components), `./avatar`, `./haptics`,
`./styles.css` (everything), and `./tokens.css`, `./fonts.css`, `./components.css` separately.

## Rules

- **Depend on nothing of an app's.** No `@/...` import, no `@ruchoir/client`: Ruchoir Lab installs
  this folder alone. A type the API also names (`Presence`) is written out here; TypeScript's
  structural typing keeps the two interchangeable. Something only one app draws (`FileIcon`, the
  Drive's file families) stays in that app.
- **Shipped as TypeScript source**, like `@ruchoir/client`: a consumer lists it in
  `transpilePackages`. It must type-check alone: `pnpm --filter @ruchoir/design-system typecheck`
  (run by the web job of the CI).
- **Styles are static CSS**, never injected at runtime (static export, strict CSP). Every rule in
  `styles/components.css` targets the components alone, through their `wc-*` classes. A rule about a
  component in one app's context (`.wc-composer .wc-ibtn`) belongs to that app's stylesheet, which
  is imported after this one.
- **Fonts are referenced relatively** (`url("../fonts/...")`), so the consumer's bundler ships them.
  Never a font CDN.
- **Changing a component changes Ruchoir Lab too** once Lab moves to the new tag. Keep props
  backwards compatible, or say in the change what Lab has to adapt.

## Principles

- **Palette**: the Ruchoir design system's, shared with the public site: grey canvas, an ink accent,
  pastels, terracotta for the mark only. The live tokens are `styles/tokens.css`; see the root
  `AGENTS.md` for the rules.
- Typography: IBM Plex Sans (UI, 14px body) and IBM Plex Mono (code), self-hosted (OFL).
- Recreate the mockups faithfully in React; do not copy prototype internals when they do not fit.
- The source handoff lives locally (and gitignored) at `ruchoir-design-system/`.
