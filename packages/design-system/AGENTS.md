# AGENTS.md - packages/design-system

Ruchoir's design system as a repo package: design tokens and React components recreated
from the Claude Design handoff. See root `AGENTS.md` for project-wide rules.

## Status

Placeholder. Not implemented yet. The source handoff lives locally (and
gitignored) at `ruchoir-design-system/`: CSS tokens, React components, screen mockups,
and an oxlint adherence config.

## Principles (when work starts)

- **Palette**: the Ruchoir design system's, shared with the public site: grey canvas, an ink accent,
  pastels, terracotta for the mark only. The live tokens are `apps/web/app/tokens.css`; see the root
  `AGENTS.md` for the rules.
- Typography: IBM Plex Sans (UI, 14px body) and IBM Plex Mono (code), self-hosted (OFL).
- Recreate the mockups faithfully in React; do not copy prototype internals when they do
  not fit. Ship the oxlint adherence config so token usage is enforced.
