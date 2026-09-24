# ADR 0001: Web Push through the browser vendors' push services, without content

- Status: accepted
- Date: 2026-09-24

## Context

A notification used to reach a person only through a Ruchoir page open somewhere: the real-time hub
pushes to connected pages, and the page draws a system notification with the browser's
`Notification` API. With every tab closed, or with the app installed on a phone and not running,
nothing arrived at all. For a messaging product that is not a missing feature, it is the product
not working.

The web platform offers exactly one way to wake a closed browser: **Web Push** (RFC 8030), where
the server posts to an endpoint run by the browser's vendor, which wakes a service worker on the
device. The vendor is not ours to choose: Chrome, Edge and every Chromium browser use Google's
service (FCM), Safari uses Apple's, Firefox uses Mozilla's. There is no self-hosted alternative for
a browser, and none is coming.

That collides with golden rule 2 ("no US or non-European hosted services at runtime").

## Decision

Web Push is adopted as a **documented, bounded exception** to golden rule 2:

1. **No content ever leaves the instance.** Pushes carry no payload. They only wake the service
   worker (`apps/web/public/sw.js`), which asks the instance what to show
   (`GET /api/v1/push/pending`) over the same authenticated, same-origin connection the app uses.
   The vendor learns that one of its subscribers received something at a given time: not who wrote,
   not where, not a word of it. No payload also means no content encryption to get right.
2. **Opt-in, per person and per browser.** Nothing subscribes on load; a person turns it on from
   the preferences (or the one-time prompt after sign-in), for the browser they are using.
3. **An administrator can refuse it for the whole instance** (`instance_settings.web_push_enabled`,
   in the instance administration). Turning it off also forgets every subscription.
4. **Only known push services are called.** A subscription endpoint is a URL the client supplies;
   the API only ever posts to hosts in `RUCHOIR_PUSH_ALLOWED_HOSTS` (the major vendors by default),
   so a subscription cannot be used to make the server reach arbitrary addresses.
5. **A sovereign fallback exists alongside it.** What stays unread for a while (fifteen minutes by
   default) while no Ruchoir page is open goes out as one email digest through the instance's own
   relay. An instance with Web Push off still reaches people.

## Consequences

- The server holds the notification preferences (they used to live in each browser), because it now
  acts on them: `user_preferences.notifications` for the global switches and quiet hours,
  `channel_members` / `dm_participants` for each conversation.
- The instance has a VAPID key pair (RFC 8292), generated on first use and stored encrypted with
  `RUCHOIR_SECRET_ENCRYPTION_KEY`. Changing that key regenerates the pair and drops every
  subscription; browsers subscribe again on their next visit.
- One new outbound HTTPS call from the API (to a push service), made with `ureq` over rustls/`ring`.
- iPhone and iPad only offer Web Push to the app once it is added to the home screen, so the web
  client is now an installable PWA (manifest, icons, service worker) and says so on those devices.

## Alternatives considered

- **Email only.** Fully sovereign, but a digest a quarter of an hour later is not a message
  notification. Kept as the fallback, not as the answer.
- **Pushes with an encrypted payload** (RFC 8291). Also unreadable by the vendor, but it hands over
  the ciphertext's size and needs content encryption server-side, for no gain over fetching.
- **Native apps with UnifiedPush.** Sovereign on Android with a self-hosted distributor, not
  available to a web app and not on iOS. To reconsider if native apps are ever built.
