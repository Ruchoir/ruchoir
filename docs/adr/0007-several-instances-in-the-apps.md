# ADR 0007: Several instances at once in the apps, not on the web

- Status: accepted
- Date: 2026-10-20

## Context

A person may belong to spaces on several Ruchoir instances (their employer's, an association's). They
want to use all of them at once: one list of spaces, one inbox, notifications from each, on the phone
and desktop apps and, ideally, on the web.

Three facts shape what is possible:

1. **A web page is served by its instance at every visit.** Whatever runs in a page of instance A is
   what A sent that day. If that page held a session for instance B, whoever controls A (its
   administrator, or someone who broke into it) could act on B in the person's name. No transport
   trick changes that: it is who serves the code that decides.
2. **The API refuses a session token to a browser on purpose** (`token_from_browser`, ADR 0005), so
   that the web's `HttpOnly` cookie is the only way a page holds a session. Opening B to pages of A
   would mean undoing that guard and B's strict `connect-src 'self'`.
3. **The apps are installed once, signed by the publisher**, and keep their tokens in the device's
   keychain. They can talk to A and B directly, each with its own token, and neither instance learns
   of the other.

`@ruchoir/client`, shared by the web and the apps, had a single module-level configuration (one
address, one token), which an app talking to several instances at once cannot share: a request
started for A could finish with B's address and token after a switch.

## Decision

**The web stays one instance per tab.** No unified view, no shortcuts to other instances, no linked
sessions, no neutral web client (`app.ruchoir.com` was considered and rejected: it would be a central
service run by the publisher, still delivered afresh at each visit). `token_from_browser` is
unchanged. The security of an instance never depends on another one's.

**The phone and desktop apps hold several instances at once**, decided by Théo on 2026-10-20:

- **Spaces first**: one list of every space, grouped under a heading per instance. Switching to a
  space of another instance is one gesture.
- **One inbox for all instances**: the bell merges every instance's notifications, newest first,
  each marked with its instance; marking read goes to the instance that owns the item.
- **Notifications from every instance**: the phone registers its device with each instance. The
  relay's push stays constant and does not say which instance sent it (ADR 0006 unchanged): the
  phone's extension asks every instance what is waiting and shows the newest, tagged with its
  instance so a tap opens it there.
- **Presence**: the app is online on every instance it is connected to.
- **The API does not change.** Bearer sessions, the `/n/` native code, sockets without `Origin` and
  `push/pending` already exist.

**`@ruchoir/client` gains `createClient(options)`**: a client for one instance whose every call reads
its own options. The calls that reach an instance live in factories (`createApi(transport)`,
`createCalendarApi(transport)`); the module-level exports are the default client's, over the options
`configureClient` sets, so the web is unchanged.

### On the phone

- The Keychain holds a registry of instances (no secret) and one token per instance. The
  single-instance version's server, token, last space and app lock are migrated at first launch.
- One **scope** per signed-in instance (`apps/mobile/src/accounts/InstanceScope.tsx`): its client
  (`useApi()`), its realtime socket, its outbox and uploads, its spaces, and a summary (spaces and
  unread counts) published for the space sheet and the bell. Only the active scope draws the
  interface; a message or a file going out on one instance keeps going while another is read.
- Every screen reaches the API through `useApi()`, the client of its own instance, never through the
  module-level calls.
- Adding an instance runs the existing sign-in screens over a candidate client; an instance already
  signed in is refused. Signing out of one instance leaves the others signed in; the app lock stays
  one lock for the app.
- The extensions (notification service, widgets) read every signed-in instance from the shared
  keychain (`push.accounts`).

### On the desktop

The desktop design (step 1 not yet built) follows the same model: the spaces of every instance in
one list, one webview holding one client per instance whose requests go through the Rust proxy that
adds that instance's bearer, so the interface still never sees a token. Its toolkit decision becomes
ADR 0008.

## Consequences

- A person who only uses a browser opens one tab per instance, as today. Using several at once is a
  reason to install an app.
- `@ruchoir/client` has a rule: a call that reaches an instance goes in its module's factory, never
  at module level (`packages/client/AGENTS.md`).
- The mobile app has a rule: screens use `useApi()`; a module outside a component takes the client
  as an argument.
- A notification costs one `push/pending` request per signed-in instance (a few per phone); the
  constant push keeps telling nobody which instance sent it.
- Testing end to end needs two instances; the dev host runs one, so the phone check pairs it with a
  second real instance.
