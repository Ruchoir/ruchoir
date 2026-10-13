# ADR 0005: Native apps with Expo, no hosted services, bearer sessions

- Status: accepted
- Date: 2026-10-13

## Context

Ruchoir needs iOS and Android apps, drawn from the mobile mockups of the design system (21 phone
screens, a tablet layout, widgets). Writing two native apps is out of reach for the team, and the web
client is React already, so the realistic path is one React Native code base for both platforms.

Two questions follow from golden rule 2 (no US or non-European runtime services, prefer European or
neutral libraries):

1. React Native is governed by Meta and Expo, its usual toolkit, by Expo (650 Industries, US). Both
   are MIT libraries that run on the phone; Expo also sells hosted services (EAS Build, EAS Update,
   EAS Submit, the Expo push service) and runs an anonymous usage telemetry in its command line.
2. The web's session is an `HttpOnly`, `__Host-` cookie. A native app has no browser jar it controls,
   and the cookie store of the platform is neither the Keychain nor something the app can reason
   about (when a WebSocket sends it, when an image request does, when it is cleared).

## Decision

**Expo and React Native as libraries, on the same footing as React and Next.js on the web.** The app
is `apps/mobile` (Expo SDK 57, React Native 0.86) in the pnpm workspace. Navigation is React
Navigation, a community project, rather than `expo-router`, at equal function. Native primitives come
from Software Mansion (Kraków, Poland) where possible.

**No hosted Expo service in what is built or shipped.** No EAS Build, Update, Submit or push
service. Native builds are made on our own machines, and nothing an installed app does talks to Expo.
The Expo CLI always runs with `EXPO_NO_TELEMETRY=1`.

**One exception, for development only (2026-10-13).** Expo Go on a physical iPhone opens a project
from a development server only when the Expo CLI signs its manifest, which takes an Expo account
signed in on both the CLI and Expo Go, and an Expo project to sign for. Without a Mac there is no
other way to run the app on an iPhone. So, for development and only there:

- a free Expo account is signed in on the development machine (`npx expo login`) and in Expo Go;
- the app's development config names an Expo project, by an id read from the untracked
  `apps/mobile/.env.local` (`EXPO_DEV_PROJECT_ID`): it never enters the repository, and a build made
  without it names no Expo project;
- the development server reaches `api.expo.dev` for its development certificate, with telemetry
  still off.

What crosses is the app's configuration and a request for a certificate, from a developer's machine;
no user, no message, no file. It ends when native builds replace Expo Go (a Mac, or Android, where
Expo Go has no such check), and must not grow into builds, updates or push.

**One API client for both apps.** `apps/web/lib/data` moved to the workspace package
`@ruchoir/client`. The web keeps its defaults (relative same-origin calls, the cookie); the app sets
the instance it talks to, a bearer provider and a socket factory.

**Native sessions are bearer tokens kept in the Keychain.**

- Sign-in accepts `"session_delivery": "token"`. The 200 body then carries `session_token` (the opaque
  session id) and no cookie is set. The second-factor step-up remembers the delivery chosen at the
  password step.
- A token is refused (400 `token_from_browser`) to any request that carries `Origin` or
  `Sec-Fetch-Site`, which every browser sends on a POST: a script running in the web app can never
  take a session out of its cookie this way.
- The `AuthSession` extractor reads the cookie first, then `Authorization: Bearer <id>`. It is the
  same Valkey record, with the same idle and absolute limits; logout ends whichever was presented.
- `GET /instance` announces `native_sessions: true`; an app facing an older instance says it needs an
  update.
- The app stores the token with `expo-secure-store`, `WHEN_UNLOCKED_THIS_DEVICE_ONLY` (not in backups,
  not on another device). Downloaded files live in a cache folder emptied at sign-out.

**Expo Go first.** Until a Mac (or a macOS machine of our own) and an Apple Developer account are
available, the app is developed and tested in Expo Go, which loads it from Metro on the development
server (signed as the exception above describes). Expo Go cannot host custom native code, so
passkeys (Face ID), push notifications, widgets and the tablet layout wait for native builds; they
come with later steps.

## Consequences

- One code base, two platforms; Android is written with iOS but tested later, on a device or an
  emulator.
- Push notifications on a phone necessarily go through Apple's and Google's push services. That widens
  the exception of ADR 0001 and needs its own decision before it is built.
- Every new mobile dependency is checked like any other (origin, governance) and listed in the pinned
  versions of `AGENTS.md`.
- A change to how sessions are delivered must keep the browser refusal: it is what keeps the web's
  cookie the only way a page can hold a session.
