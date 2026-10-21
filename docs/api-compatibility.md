# Keeping apps and instances that were not updated working

The phone and desktop apps update when their stores or their users say so; each instance updates
when its administrator does. Any app version meets any instance version, both ways. Two promises
make that work, and the code holds the instance to them.

```
older app  ──▶ newer instance   works: /api/v1 only grows, the app ignores what it does not know
newer app  ──▶ older instance   works: the app asks what the instance can do, and does without
```

## 1. `/api/v1` only grows

Within `/api/v1`, nothing an app may rely on is removed, renamed, or given another type or meaning:

- a route, a method, a query parameter, a field of an answer, a realtime event or its payload's
  fields, a value an app compares against (a notification `kind`, an error `code`);
- a field of an answer that was always present stays always present, and never becomes `null`;
- what an app sends keeps being accepted as it was: no request field and no query parameter
  becomes required. Unknown fields in a request are ignored (no `deny_unknown_fields`).

What is new is added beside the old: a new field, a new route, a new event, a new optional
parameter. An older app ignores them: the clients skip fields they do not read and events they do
not know (`packages/client`, `connectRealtime`'s `default`).

**Checked in CI.** `the_v1_contract_only_grows` (`apps/api/src/compat.rs`) compares the API's
OpenAPI document with the recorded contract, `apps/api/contract/openapi-v1.json` (first recorded
from v0.2.0, the release in service on 2026-10-21). It fails on a route or method gone, a schema or
a field gone, a field read as another type (nullable included), a field no longer always present,
and a request field or parameter newly required. When the API grows, the test fails too, until the
addition is recorded:

```bash
RUCHOIR_UPDATE_CONTRACT=1 cargo test -p ruchoir-api the_v1_contract_only_grows
```

which refuses to write while something breaks. Realtime events are not in the OpenAPI document:
their names and fields follow the same rule, by review.

**A change `/api/v1` cannot take** goes to a new route beside the old one, or, for a change across
the whole API, to `/api/v2`, served next to `/api/v1` for as long as apps in use call it (at least
a year after the last app release that used it). Editing the recorded contract by hand to let a
removal through is that decision, and is made in the pull request, visibly.

## 2. The instance says what it can do

`GET /api/v1/instance` (no session needed):

| Field | What |
|---|---|
| `version` | the release it runs (`v1.2.3`, from the tag; `dev` outside a release build) |
| `api_version` | `1`, the major version of its paths |
| `features` | what it can do beyond every `/api/v1` instance, by name (`compat::FEATURES`) |

An instance older than v0.3.0 sends none of these: clients read it as `api_version` 1 with no
features, plus what its older booleans said (`native_sessions`).

A new app checks before using something new, with `supports(caps, "name")` from
`@ruchoir/client`, and does without on an instance that does not list it: a button hidden, the
older way taken. A name, once listed, is never removed nor reused for something else.

| Feature | Since | What |
|---|---|---|
| `native_sessions` | v0.2.0 | sign-in hands a native app a session token |
| `notification_read` | v0.3.0 | a read is announced to the person's other devices (`notification.read`) and their phones are synced silently (ADR 0006) |

Adding one: a name in `compat::FEATURES` (lowercase, underscores), a line in this table, and the
apps' check before they use it.

## The push relay

The relay serves every instance, whatever version each runs: its routes only grow too. An instance
newer than the relay (a `404` on `/v1/sync`) carries on without what is missing.
