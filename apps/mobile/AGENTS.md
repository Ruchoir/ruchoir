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
- **Sheet rows come from `ActionRow`** (`ui/ActionRow.tsx`): a 40 tile in a pastel, a title, a line
  under it; a destructive row in the danger colours, set apart by a hairline. Every sheet uses it.
- **A form that slides up** (people picker, new group, invitation) is a `modal` screen with
  `SheetHeader` (its title and a close button); a choice among a few things is a `formSheet` of
  `ActionRow`s.
- **A tab's own action floats** at its bottom right: `FloatingButton` (`ui/FloatingButton.tsx`),
  "New message" over Discussions, "New event" over the Agenda. Its list keeps 96 of room under it.
- **Confirmations and failures elsewhere** go through `useToast()` ("Texte copié", "Réaction non
  enregistrée"); a question that needs an answer is an `Alert`.
- Check a change against the mockup side by side before calling it done (`docs/specs/mobile/mockups`).

## Layout

```
src/App.tsx            fonts, session, then the signed-in navigator
src/session/           instance choice (server.ts), the session reducer (machine.ts), Keychain store
src/api/instance.ts    configures @ruchoir/client for the chosen instance (bearer, socket headers)
src/realtime/          one socket for the session; screens subscribe and refetch on resync; local
                       "patched" events carry my own changes (a reaction, a pin, an edit) to every screen
src/compose/           the composer (mentions, files, edit mode), the outbox and drafts (above the
                       screens), typing, attach sheet, and the request bus sheets use to reach a composer
src/space/             the space on screen, remembered between launches
src/data/              useLoad (requests per screen), useReloadOn (live refetch), members, useNow
src/logic/             pure functions, tested by Node: conversations, inline Markdown, agenda, today,
                       mentions, outbox, unread, reactions, receipts, threads, attachments, handle,
                       eventForm (the event form as data), availability
src/screens/agenda/form/  the event form, its sheets (calendar, date and time pickers, repeat, custom
                       rule, reminders, people, channel, time zone, series scope) and its draft store
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
- **Every write shows at once and says when it fails.** A message goes through the outbox
  (`compose/useOutbox.tsx`), which recognises its own message when it arrives live, since the API
  takes no idempotency key: never re-send an item `arrivedIds` has matched. Reactions for one
  message and emoji go out in order (`compose/useReact.ts`).
- **A sheet is its own screen** (native `formSheet`), so it cannot call into the conversation under
  it: it emits a `patched` realtime event for what it changed, or asks through `compose/requests.ts`
  (edit a message, add files) keyed by the composer's `draftKey` (`<conversation>` or
  `thread:<root>`).
- **A sheet's root is one scroll view** (`Sheet`, or a `ScrollView`/`FlatList` whose head is pinned
  with `stickyHeaderIndices={[0]}`). On iOS a `formSheet`'s content has no set height
  (react-native-screens lays it out absolutely, without a bottom), so a `flex: 1` root with a fixed
  head and a list filling the rest draws the list under the head. The keyboard has the same kind of
  trap: use `ui/KeyboardArea` (a chat, a list) or `ui/KeyboardForm` (a form), not
  `KeyboardAvoidingView`. A `KeyboardArea` must run to the bottom of its screen and rises by the
  keyboard's whole height, measuring nothing (a view's place in the window, as React Native reports
  it, leaves out the offset of the sheet it is in); give it `safeBottom` rather than wrapping it in a
  `SafeAreaView` with a bottom edge. Its height comes from react-native-keyboard-controller
  (`useKeyboardHandler`, under the `KeyboardProvider` of `App.tsx`), which reads the keyboard's real
  position at every frame, so whatever it holds moves with the keyboard; a function run there
  (`areaPlacement`) starts with the `"worklet"` directive. Not Reanimated's `useAnimatedKeyboard`: it
  guesses the keyboard's position from a curve, and the composer trailed iOS 26's keyboard. A chat's
  area is a `composer` one that `slide`s while its list shows: it moves with the keyboard and takes
  its new size only once the keyboard rests. Never resize a list at every frame: each frame
  re-renders it, Reanimated holds its own updates while React commits, and the composer falls
  behind the keyboard.
- **Every field stays in sight above the keyboard.** A form is a `KeyboardForm`, its button passed
  as its `footer`: the library's `KeyboardAwareScrollView` scrolls the focused field up along with
  the keyboard, frame by frame, and the footer rides on the keyboard. Never scroll to a field once
  the keyboard has risen (`keyboardDidShow`): the field stays behind the keyboard until then. A list
  under a search field gets `automaticallyAdjustKeyboardInsets`, so its last rows can still be
  scrolled above the keyboard. A long list of people is a `PeopleList` (a `FlatList`), never rows
  mapped inside a form.
- **Thread replies never enter a feed.** `screens/discussions/feed.ts` keeps a conversation's and a
  thread's messages live; a reply moves the count under its root once (`replyDelta`).
- **Seeded files of the dev database have no bytes** in the dev object store: opening one answers
  404 there, on the web as well. Upload a file to test the viewer.
- **A form whose sheets change it keeps its draft outside itself.** The event form opens its draft in
  `screens/agenda/form/draftStore.ts` under a `formKey` it hands to every sheet it opens (each sheet is
  a screen of the root stack, as all sheets are); the sheets read it with `useDraft` and change it with
  `updateDraft`, and the form closes it when it goes. A choice a sheet hands back to the screen under
  it (the scope of a change to a series) goes through a small listener bus, as the composer's
  requests do (`form/scope.ts`, `compose/requests.ts`).
- **Dates and times come from the phone's own pickers** (`@react-native-community/datetimepicker`, the
  version Expo Go ships): in a sheet on iOS (`PickerSheet`, `inline` for a day, `spinner` for a time),
  as the system's dialog on Android (`DateTimePickerAndroid.open`). A picker works on the phone's
  clock: `form/when.ts` hands it a day at noon and a time on a fixed day, and reads the same local
  fields back, so no time zone shifts them. The draft keeps the event's own zone (`tz`).
- **The calendar's logic is the web's** (`@ruchoir/client/calendarLogic`: time in a zone, rules and
  their phrases, reminders and their words). Its keys are looked up in this app's dictionaries too:
  `useSharedT()` hands it `t`, and the audit scans it with the app.

## Checks

```bash
pnpm --filter @ruchoir/mobile typecheck
pnpm --filter @ruchoir/mobile lint
pnpm --filter @ruchoir/mobile test
pnpm --filter @ruchoir/mobile i18n:check
CI=1 pnpm --filter @ruchoir/mobile bundle:ios   # proves Metro resolves and bundles the app
```
