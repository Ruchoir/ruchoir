# ADR 0010: The open-core boundary, and one licence per space verified offline

- Status: accepted
- Date: 2026-11-03

## Context

Organisations asked for roles composed permission by permission, groups that carry roles, fine rules
on a channel or a folder, delegated administration, directory sync and audit export. Building those
takes time a free product alone does not pay for, so they are sold, per space, as an enterprise
edition. Three constraints shape how:

1. **What ships under the AGPL cannot be taken back.** The line between free and paid has to be drawn
   before the first paid feature is written, and everything free today stays free.
2. **The free product must stay whole.** An organisation running only this repository gets a
   complete collaboration suite, its permission engine included, with nothing crippled.
3. **No call home** (golden rule 2). An instance never asks anyone whether it may run.

## Decision

**The rule: the free core handles preset levels; the paid edition composes à la carte and delegates
at scale.**

| Free (this repository, AGPL) | Paid (enterprise edition) |
|---|---|
| The permission engine and its catalogue, which evaluate everything stored, custom roles included | Custom roles, permissions chosen one by one |
| The four fixed roles (owner, Administrator, member, guest) with their fixed rights | Tuning the base roles, guests' rights included |
| Simple groups, usable as share targets | Groups that carry roles, group managers |
| Sharing a channel, a folder or a file with people or groups, by preset level | Fine rules on a resource, permission by permission |
| Guests: standing, ceiling, expiry | A role hierarchy with custom roles, local delegation |
| The audit log in the space settings | Audit export and SIEM, directory sync (SCIM) |
| "Why does this person have access?", imports (custom roles brought down to fixed ones) | Importing custom roles as they are |

**The edition is a trait, and the dependency points one way.** The API crate is a library;
`ruchoir_api::run(edition)` runs the server as an `Edition` (`apps/api/src/edition.rs`), which says
what a space is entitled to (`Community`, `Enterprise` until a date for a number of seats, or `Frozen`
once that date has passed), whether one more member may join it, and which routes, feature names and
background jobs it adds. This repository ships `CommunityEdition`: every space is `Community`, nobody
is ever refused a seat, nothing is added. The enterprise edition lives in its own repository, depends
on this crate pinned to a commit, and provides its own binary and image. This repository never names,
fetches or requires it: declaring it here, even as an optional feature, would make every build fetch
a repository the public cannot reach. What another build may use from the core is explicit and small:
the modules `edition`, `state`, `config`, `entities`, the re-exports of `ext`, and the shared test
server `testkit`.

**One licence is one space.** A licence names the space it was issued for, the organisation, a
number of seats and an end date, and is signed (Ed25519). The owner installs it in the space's
settings (web, desktop, phone), by pasting it or picking its file; the server verifies the signature
offline against the public key compiled into the enterprise build. No network call, ever, at
installation or later. Ruchoir's own spaces run on ordinary licences issued for them.

**Seats count owners and members, never guests.** When every seat is taken, issuing or accepting a
member invitation and making a guest a member are refused (`402 seats_full`, with a link to the
pricing page, `RUCHOIR_PRICING_URL`); guests can still be added, and nobody already in a space ever
loses access, including after a licence with fewer seats.

**An expired licence freezes, it does not remove.** The space's rules keep applying and can no longer
be edited; owners are reminded 30, 7 and 1 days before the end (a banner and a mail). There is no
grace period because freezing is already harmless. Nothing is ever deleted on a downgrade: a deny
rule that disappeared would be an access that appeared. A community image started on a database a
licensed build wrote reads every space as `community`, offers no paid route, and keeps applying every
rule it finds there.

## Consequences

- The public repository builds, tests and runs on its own, as before; its CI never needs access to
  anything private.
- A paid feature's data lives in the core schema (the schema is not the product: `space_licences`,
  custom roles in `space_roles`), so a downgrade or a rollback never leaves rows nobody can read.
- Widening `ext` widens what another build depends on: it is done when that build needs something,
  and kept stable after, like `/api/v1`.
- Linking a proprietary module into AGPL code is possible only for the holder of that code's
  copyright: every contribution to this repository has to be the project's to license, which is
  checked before an enterprise image ships.

## Alternatives rejected

- **A licence server.** Simpler revocation, but every instance would call home, which this product
  never does, and a server down would lock organisations out of their own data.
- **One licence per instance.** It cannot price a hosted instance serving several organisations, and
  forces self-hosters with one paid team and several free ones to pay for all.
- **Paid features in this repository behind a flag.** Anything shipped under the AGPL can be turned
  on by anyone; the boundary would be a suggestion.
- **Removing or locking data when a licence ends.** Punishes the people who use the space for a
  decision they did not take, and a removed deny rule opens access that was closed on purpose.
