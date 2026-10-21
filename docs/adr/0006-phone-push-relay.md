# ADR 0006: Phone notifications through a publisher-run relay, without content

- Status: accepted, amended 2026-10-21 (reading everywhere, see the end)
- Date: 2026-10-15
- Widens: ADR 0001 (Web Push), ADR 0005 (native apps)

## Context

ADR 0001 lets a browser be woken by its vendor's push service, carrying a constant marker and never
any content: the woken page asks its instance what to show. The phone apps need the same, and on a
phone there is no choice of service either: an iPhone app is woken only by Apple's (APNs), an
Android app installed from Google Play reliably only by Google's (FCM).

Two things differ from the web:

- **The sending key belongs to the publisher.** A browser accepts a push from whoever holds the
  subscription. APNs and FCM accept a push for an app only from whoever holds the app's own key
  (an APNs key of the Apple team that publishes Ruchoir, a Firebase project's service account). A
  self-hosted instance cannot hold it: the key would then be on every instance, and anyone could
  push to every Ruchoir phone.
- **The app is not a page.** On iOS a woken app does not run JavaScript; only a Notification Service
  Extension may change what is shown, in the few seconds before it is.

## Decision

1. **A relay run by the publisher**, in Europe (the website's server, `https://ruchoir.com/push/`).
   An instance posts `{platform, token}` to it; the relay sends a push for that device with the keys
   it alone holds. It keeps nothing: no account, no log of tokens, no queue. It answers `410` for a
   device the vendor says is gone, so the instance forgets it.
2. **Still no content.** What the relay sends is constant: to Apple an alert reading "Ruchoir" with
   `mutable-content`, to Google a data message `{"ruchoir": "wake"}`. Neither the relay nor the vendor
   learns who wrote, where, or what; not even which instance (the payload does not name it).
3. **The phone asks its instance what to show**, exactly as the service worker does
   (`GET /api/v1/push/pending`, bearer token):
   - iOS: a Notification Service Extension replaces the alert with the item's title and text. It
     reads the instance's address and a copy of the session token from a keychain group shared with
     the app (`<team>.com.ruchoir.app.shared`), stored *after first unlock*, so a notification can be
     read while the phone is locked: the same choice every messaging app makes. When it cannot reach
     the instance, it says only "New activity".
   - Android: the data message wakes a background task in the app, which fetches the same items and
     draws them as local notifications.
4. **Opt-in, on this phone.** The app asks after sign-in (screen 08) and from its notification
   preferences; it registers its device token with its instance (`PUT /api/v1/push/devices`) at every
   start while allowed, and removes it at sign-out. The instance forgets a device unseen for sixty
   days, and every device of an account when all its sessions end (sign out everywhere, a password
   change or reset). A test from the preferences (`POST /api/v1/push/devices/test`) takes the same
   way as a real notification: the relay wakes each phone, which collects the test once from
   `GET /api/v1/push/pending`, as the browsers' test does.
5. **The instance decides when**, with the rules of ADR 0001 unchanged (`prefs::allows`, quiet hours,
   "do not disturb"): a phone is reached exactly when a browser would be. The administrator's switch
   (`web_push_enabled`) covers phones too. `RUCHOIR_PUSH_RELAY_URL` names the relay; empty turns
   phone pushes off for the instance.
6. **Abuse.** The relay is open to every instance by design (any self-hosted Ruchoir must reach its
   users' phones), so it is rate-limited per address and per device, accepts only a token-shaped
   token and a known platform, and can only ever send the constant payload: the worst a stranger
   holding a token can do is make that phone show "Ruchoir" once in a while. Tokens are known only
   to the phone, its instance, and the vendor.

## Consequences

- The publisher operates one more service, with two secrets on its server only: the APNs key
  (`.p8`, its key id, the team id) and the Firebase service account. Without them the relay answers
  `503` and nothing else breaks: the email digest of ADR 0001 still reaches people.
- An instance makes one more outbound call (to the relay), only for accounts with a registered
  phone.
- The iPhone build carries a second target (the extension) and the push entitlement; the Android
  build needs the Firebase project's `google-services.json` at build time.
- The App Store and Play privacy forms must mention device tokens held by the instance and passed
  to the relay and the vendor (`stores-checklist.md`).

## Alternatives considered

- **The vendor keys on each instance.** Impossible without publishing them.
- **Content in the push.** Simpler (no extension, no background task), but every message would go
  through the relay and the vendor. Rejected, as in ADR 0001.
- **UnifiedPush on Android.** Sovereign, but it needs a distributor app on the phone that almost no
  one has; Google Play phones are reached through FCM. Can be added later beside it.

## Amendment, 2026-10-21: read on one device, read everywhere

A notification read on the computer used to stay on the phone: its dot on the icon, and the
notification itself on the lock screen, until the app was opened. Théo asked for one read to count
everywhere.

1. **On the devices that are open**, the instance says so on the realtime socket:
   `notification.read`, to the person only, with the ids read (or `all`) and what is left unread.
   The web and the desktop mark them read in the bell and refresh the counts; the phone app counts
   again and takes them off its screen.
2. **On a phone whose app is closed**, a second constant push, through the same relay: a **sync**,
   on a route of its own (`POST /v1/sync`, same body as `/v1/send`). It shows nothing and carries
   nothing: to Apple a background push (`content-available`, push type `background`, priority 5),
   to Google a data message `{"ruchoir": "sync"}` at normal priority. The app, woken in the
   background (the iPhone app gains the `remote-notification` background mode, and nothing else),
   asks each of its instances which notifications are still unread, puts the total on the icon, and
   takes the read ones off the screen (each carries its id since this change). Nothing is drawn.
3. **Sparingly.** The instance waits three seconds after a read and sends one sync for the whole
   burst (reading one, then another, then "mark all read"); only when something was actually read,
   only to phones it would wake anyway (the administrator's switch). The relay gives syncs their own
   allowance (10 a minute per device), so reading never holds back a new message. Apple may still
   delay or drop a background push, and never delivers one to an app the person swiped away: the
   count is then right again at the next push or when the app opens. An instance whose relay
   predates `/v1/sync` gets a `404` and carries on.

What crosses does not change: the relay and the vendor learn that a device has something to update,
not what, nor from which instance; not even the count.

The relay is deployed apart from instances, by a tag of its own (`push-relay-v1.2.3`,
`docs/push-relay.md`, "Releasing"), on the website's server.

