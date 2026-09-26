# ADR 0002: Link preview cards drawn by the API

- Status: accepted
- Date: 2026-09-26

## Context

When an address of an instance was pasted into a chat app (an invitation above all), the preview
was the bare title "Ruchoir" and an English sentence, with no image. Two things were in the way:

1. The web client is a static export: one `index.html` for every path, so the tags a scraper reads
   could not depend on the link.
2. The API only answered a path with the app shell when the request said `Accept: text/html`.
   Browsers do; many scrapers send `*/*` or nothing at all, and received a `404`.

A preview is also read by people who are not members: a chat app's scraper is not signed in, and
the card it builds is shown to everyone in the conversation. Whatever a card says is public to
anyone holding the link.

## Decision

The API serves every page navigation itself and adds Open Graph and Twitter tags that fit the path,
pointing at a card image it draws (`apps/api/src/og`).

- **A navigation is recognised by its shape, not only its `Accept`:** `GET`, no file extension, not
  under `/api/`, `/_next/` or `/emoji/`, and an `Accept` that is missing, `*/*` or includes
  `text/html`. A missing asset or an API call keeps its truthful `404`.
- **Eight cards**, one per kind of link: the home page (with the instance's address), a valid
  invitation, an invitation that would not be accepted, a channel or message, a space, a personal
  email link (address confirmation, password reset: a warning not to share it), and the status page
  (all good, or an incident, from the same probe as `/api/v1/health`).
- **A card never says more than the link does.** A channel, a message or a space is a locked,
  anonymous card. Only a *usable* invitation names its space and who sent it, which is what its own
  screen already shows before sign-in, plus the number of members and of **public, active**
  channels (a private channel is never counted). An unusable token draws the one expired card, so
  nobody can make the server draw text of their choosing. Personal and invitation pages carry
  `noindex`, and no page repeats its query string (a token) in `og:url`.
- **One language per instance:** a scraper says nothing about its reader, so cards and tags are in
  the instance's own language, `RUCHOIR_DEFAULT_LOCALE` (French by default, like the emails).
- **Drawn as SVG, rendered to PNG with `resvg`.** The templates are Rust format strings following
  the design mockups; the fixed cards are drawn once per process, the invitation card per request
  (tens of milliseconds, off the async workers).
- **Everything a card uses is embedded in the binary** (`apps/api/assets/og`): IBM Plex Sans and
  Mono as TTF (OFL, from IBM's own repository; `resvg` does not read the web's WOFF2), the Ruchoir
  bee from the public site's sprite plus two variants made for these cards (a letter, a honeycomb),
  four Fluent emoji (Microsoft, MIT, the set the web client already uses) and three default avatars
  (DiceBear, as the client generates them). The image resolver refuses any other reference, so
  rendering reads neither the disk nor the network.

### The new dependency (golden rule 2)

`resvg` 0.48, with `usvg`, `tiny-skia`, `fontdb` and their parsers. Maintained by **Linebender**, a
community organisation with no company behind it, dual MIT/Apache-2.0, pure Rust. Only the `text`
and `raster-images` features are enabled: not `system-fonts` nor `memmap-fonts`, so no font is read
from the host. The raster decoders it pulls (`zune-jpeg`, `image-webp`, `gif`) come from the same
community `image-rs` family the thumbnails already depend on.

## Consequences

- The app shell is no longer served by `ServeDir` directly for navigations: it goes through
  `og::page`, which reads `index.html` (or `status/index.html`) and inserts the tags before
  `</head>`. It keeps `Cache-Control: no-cache`.
- New public routes: `GET /api/v1/og/{name}` (the fixed cards, `status.png` redrawn per state) and
  `GET /api/v1/og/invite/{token}`. Both are unauthenticated, like the pages that point at them.
- The binary grows by about 600 KB (the three fonts).
- A sentence on a card is laid out by hand: a rendered SVG does not wrap. `apps/api/src/og/text.rs`
  holds every language's lines, and `RUCHOIR_OG_DUMP=<dir> cargo test og::` writes every card in
  every language to look at after a change.
- The development front (`next dev` behind nginx) does not go through the API for pages, so the
  tags only appear where the API serves the bundle (production, or the dev API's own port).

## Alternatives considered

- **One static image for every link.** No new dependency, but an invitation, the link most often
  pasted, would say nothing about the space it opens.
- **Names in the tags only, a fixed image per kind.** Most chat apps show the title under the
  image, but the image is what is seen first; the invitation card was the point.
- **A headless browser to render HTML mockups.** Heavy, a second runtime in the image, and a new
  attack surface for text that comes from users.
