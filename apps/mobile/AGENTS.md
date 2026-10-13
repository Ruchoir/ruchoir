# AGENTS.md - apps/mobile

The Ruchoir app for iOS and Android, built with Expo. See the root `AGENTS.md` for project-wide
rules; this file holds what is particular to the app.

## Rules

- **No hosted Expo service in anything built or shipped** (golden rule 2, ADR 0005): no EAS Build,
  Update, Submit or push. Native builds happen on our own machines. The only exception is the
  development signing Expo Go needs on a physical iPhone: an Expo account on the development
  machine, and `EXPO_DEV_PROJECT_ID` in the untracked `.env.local`, never a project id in the
  repository.
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

## Design consistency

The mockups (21 phone screens) are the reference; the web's design system fills what they do not
show. What every screen keeps:

- **Gutter 16**, rows of a list 10 vertical padding, 12 between the icon and the text; a row with no
  second line centres its single line.
- **Icon tiles**: 40 in lists, 32 in a sheet's rows, radius 10 (8 for 32); the header avatar is 36.
- **One empty state, `EmptyState`** (`ui/States.tsx`), the web's: the icon as a sticker (accent
  pastel, 2 px ink edge, -4 deg, hard offset shadow), a short title without a full stop, and one
  sentence saying what will appear there. `hero` for a whole screen, `compact` inside content (a
  day with nothing, a search with no result). Never a bare line of grey text. Never inside an
  inverted list (it would be drawn upside down): render it instead of the list.
- **Day headings** come from `useDayLabel` (`Aujourd'hui · mardi 13 octobre`, else `Mercredi 14
  octobre`), and a list of events is grouped by day with `groupByDay`, wherever it appears.
- **Dates on rows**: a conversation shows the time today (`listStamp`), a file the day as a word
  (`dayStamp`: aujourd'hui, hier, the weekday, then the date).
- **Pills and segmented controls** come from `Chips` and `Segmented`; a count in a pill is a small
  muted number, not a badge.
- Check a change against the mockup side by side before calling it done (`docs/specs/mobile/mockups`).

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
