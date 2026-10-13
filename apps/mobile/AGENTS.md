# AGENTS.md - apps/mobile

The Ruchoir app for iOS and Android, built with Expo. See the root `AGENTS.md` for project-wide
rules; this file holds what is particular to the app.

## Rules

- **No hosted Expo service, ever** (golden rule 2, ADR 0005): no EAS Build, Update, Submit or push,
  no Expo account, no `projectId` in `app.config.ts`. Native builds happen on our own machines.
- **No telemetry from the tooling.** Every Expo CLI invocation runs with `EXPO_NO_TELEMETRY=1` (the
  package scripts set it); a new script must too.
- **No deployment hostname in the repository.** The development server comes from
  `apps/mobile/.env.local` (`EXPO_PUBLIC_DEFAULT_SERVER`, untracked).
- The API is reached only through `@ruchoir/client` (`packages/client`), configured for the instance
  the person chose. A session is a bearer token kept in the Keychain, never anywhere else.
- **The token only travels to the instance.** An image or a download that the app fetches itself
  takes its headers from `authHeadersFor(url)`, which gives nothing for another host
  (`src/api/sameInstance.ts`); never pass `authHeaders()` to a URL that came from data.
- Every string a person reads goes through i18n, French first, the five other languages complete
  (`pnpm --filter @ruchoir/mobile i18n:check`).
- Colours come from `src/theme/tokens.ts`, a copy of `apps/web/app/tokens.css` kept honest by
  `test/tokens.test.ts`.

## Layout

```
src/App.tsx            fonts, session, then the signed-in navigator
src/session/           instance choice (server.ts), the session reducer (machine.ts), Keychain store
src/api/instance.ts    configures @ruchoir/client for the chosen instance (bearer, socket headers)
src/realtime/          one socket for the session; screens subscribe and refetch on resync
src/space/             the space on screen, remembered between launches
src/data/              useLoad (requests per screen), useReloadOn (live refetch), members, useNow
src/logic/             pure functions, tested by Node: conversations, inline Markdown, agenda, today
src/navigation/        root stack (pushed screens, sheets) and the four tabs
src/screens/           auth, today, discussions, agenda, files, account, space
src/ui/                design-system pieces: Text, Button, TextField, Avatar, Chips, Segmented...
src/theme/             tokens.ts (copy of tokens.css), IBM Plex, useTheme
src/i18n/              i18next and the six dictionaries
```

## Gotchas

- **Route names are lower camel case** (`today`, `fileViewer`): the i18n audit reads a capitalised
  single word as prose.
- **The audit only sees literal keys**: `t("a.b")` or `key("a.b")`. A key chosen at run time goes
  through a table of `key(...)` (see `session/failureText.ts`), and a ternary is written
  `cond ? t("a") : t("b")`, never `t(cond ? "a" : "b")`.
- **No `Date.now()` or `new Date()` for "now" in render** where the lint can see it: `useNow()`.
- **`useLoad` keys name what is loaded** (`"conversations:<space>"`); a new key never shows the old
  key's data, which is what keeps a space switch from painting the previous space.
- **Seeded files of the dev database have no bytes** in the dev object store: opening one answers
  404 there, on the web as well. Upload a file to test the viewer.

## Checks

```bash
pnpm --filter @ruchoir/mobile typecheck
pnpm --filter @ruchoir/mobile lint
pnpm --filter @ruchoir/mobile test
pnpm --filter @ruchoir/mobile i18n:check
CI=1 pnpm --filter @ruchoir/mobile bundle:ios   # proves Metro resolves and bundles the app
```
