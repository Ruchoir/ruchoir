# ADR 0005: Native apps with Expo, no hosted services, bearer sessions

- Status: accepted, amended 2026-10-14 (builds, see the end)
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
service. Native builds are made on GitHub's runners (amended 2026-10-14, below), and nothing an
installed app does talks to Expo.
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
no user, no message, no file. It must not grow into builds, updates or push. It was meant to end
with native builds; it stays, since Expo Go remains the everyday tool (amended 2026-10-14, below).

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

## Amendment, 2026-10-14: how the apps are built and installed (step 6b)

**Builds run on GitHub Actions**, the iPhone on GitHub's macOS runner and Android on its Linux runner
(`.github/workflows/mobile-build.yml`, `docs/mobile-builds.md`). The team has no Mac; GitHub already
builds the server's release images, and its runners are free for a public repository. Rejected: a
rented Mac mini (Apple's licence imposes a 24-hour minimum lease, and Xcode would be reinstalled each
time) and EAS Build (a hosted Expo service, which this ADR excludes). The workflow runs on demand only
(its button, or the label `app-build` on a pull request of this repository) and never for a fork.

**What is built is a development build** (`expo-dev-client`): Ruchoir itself with Expo's development
launcher, which opens Metro. It carries what Expo Go cannot host (biometrics, push, widgets,
passkeys, a native scanner) and is rebuilt only when something native changes.

**The iPhone build reaches the phone through App Store Connect and TestFlight**, internal testing
only, the only channel Apple allows without a Mac or registered devices. Apple signs it: the archive
is made unsigned, then Xcode's cloud signing, authenticated by an App Store Connect team key with the
Admin role, signs it at export, so no certificate is stored anywhere. The upload goes through the App
Store Connect API's build uploads, with the same key: Xcode's own upload, through Apple's content
delivery service, refused that key ("Cannot verify client's JWT headers") while the API accepted it.
The key and its identifiers are repository secrets set by the account holder. Android's debug APK is
an artifact of the run, for an emulator; Google Play comes with the store releases.

**Expo Go stays the everyday tool**, by the team's choice: a JavaScript change shows at once, without
a build. The development exception above therefore stays, and Metro starts in Expo Go mode
(`expo start --go`), which the development build opens too. A native library that Expo Go lacks is
reached only where present, so the rest of the app still opens in Expo Go.

Apple (App Store Connect, TestFlight) and GitHub are US services. Neither sees a user, a message or a
file: they receive the app's code, which is public, and Apple distributes it, as it will distribute
the store release. Golden rule 2 is about what an installed app talks to, and that does not change.
