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
| `account_preferences` | unreleased (after v0.4.0) | `GET`/`PATCH /api/v1/me/preferences` and `preferences.updated`: the preferences that follow the account; `hidden` on a direct conversation, `PUT /api/v1/me/dms/{id}/hidden` and `dm.hidden` |
| `native_sessions` | v0.2.0 | sign-in hands a native app a session token |
| `notification_read` | v0.3.0 | a read is announced to the person's other devices (`notification.read`) and their phones are synced silently (ADR 0006) |
| `office_desktop_embed` | unreleased (after v0.4.0) | `embed_origin` on `POST /api/v1/files/{id}/office`: the desktop app names its own origin, the editor posts its messages there, and the engine's pages accept the desktop origins as frame ancestors. Without it the office editor stays blank in the desktop app |
| `recent_reactions` | v0.3.0 | `GET /api/v1/me/recent-reactions`: the emoji someone reacted with last, which the quick reactions lead with |
| `reply_to_channel` | v0.3.0 | a thread reply may be sent to its channel too (`also_in_channel`), shown there under a line naming its thread (`thread_root`) |
| `permissions` | after v0.4.0 | spaces, channels and listed files carry `my_permissions` (what the caller may do there, by permission name, catalogue order); `permissions.changed { space_id }` says when to ask again (ADR 0009). An older instance sends neither: the role decides, as before |
| `guest_expiry` | after v0.4.0 | a guest's end date: `guest_expires_at` on invitations, `PUT .../members/{user}/expiry`, `GET .../members/ended`, `POST .../members/{user}/reactivate`, `standing` and `expires_at` in the member list, `expires_at` on a space, and the two guest notices (opt in with `guest_notices=true`) |
| `groups` | after v0.4.0 | `GET`/`POST /api/v1/spaces/{id}/groups`, `PATCH`/`DELETE .../groups/{group}`, `POST .../groups/{group}/members` and `DELETE .../members/{user}`: a space's groups of people, each with what the caller may do (`may`), and a member's `group_ids` in the space's member list. An older instance answers `404` and leaves `group_ids` out: nothing changes for its apps, and a mention of a group arrives as plain text |
| `resource_rules` | after v0.4.0 | `GET /api/v1/spaces/{id}/access/{kind}/{resource}` (`kind` is `channel`, `file` for a file or folder, or `calendar`), `PUT .../entries`, `DELETE .../entries/{rule}` and `GET .../why?user_id=` ("Pourquoi ?": the engine's own steps for a person on that resource, in order, each naming the rule, the role and the group carrying it, then the result per permission; read only, nothing logged; somebody else needs `members.view`, a resource the caller cannot see is a `404`; a role step says whether the person holds it `direct`ly and lists every group carrying it in `via_groups`; a step on a folder or channel the caller cannot open stays in the list with `hidden: true`, no name and no id, on purpose: the person's access depends on it): who has what on a channel, file or calendar by preset level (`none`, `read`, `contribute`, `manage`, or `custom` for a rule matching no preset), inherited lines of a file, and what the caller may do (`may`). Setting "everyone" below `manage` keeps an Administrator line at `manage` on a channel, calendar, file or folder, so administrators still manage what is hidden from members. The levels of "everyone" and of the Administrator keep driving the older settings (`allowed_roles`, `write_access`) both ways. Deleting a group a rule names answers `409 group_has_rules` with `used_in` (`kind`, `id`, `name`; a place the caller cannot open, such as a private channel they never joined, is `kind` and `hidden: true` only). The individual restrictions (a rule that denies something to one person) are listed to the editors of the resource only; a reader sees the allows, the groups and the roles. A write that lifts a restriction (a delete, a lower level) needs the caller to hold what it restores (`403 cannot_grant`). A rule aimed at one person is deleted with that person's membership (a rule on someone no longer in the space means nothing); a rule aimed at a role or a group never goes with it. The file share routes (`GET`, `POST` and `DELETE /api/v1/files/{id}/shares`) keep their shapes but are now backed by rules: a share with a person is a person rule and a share with a channel an audience rule (its readers), `view` is `read` and `edit` is `contribute`, the share `id` is the rule's id, and sharing again with the same target answers `200` instead of adding a line, raising the level when it asked for more but never lowering a rule that already allows at least what was asked (a Gérer or custom rule an older app lists as `edit` is not demoted by it); the same checks as the Access dialog apply, so a share can answer `403` (`cannot_grant`, `target_above_you`), `402 licence_required` or `409 licence_frozen`, and the file's author can still share (with a channel they read too, but never adding or removing a deny for it). The listing shows only what the Access dialog would show that reader: a guest sees the rows that cover them, and a row whose channel the reader cannot view is left out. An older app therefore sees a share that really grants access (it used to be a note only), and the shares written before this version stay in the table without effect and are no longer listed (their ids answer `404`). An older instance answers `404`: its apps keep reserving a channel by role and a calendar by `write_access`, as before |
| `licences` | enterprise edition | `GET`/`PUT`/`DELETE /api/v1/spaces/{id}/licence` for the space's owners (installed by and when included), `GET /api/v1/admin/licences` for the instance's administrator (ADR 0010) |
| `custom_roles` | enterprise edition | `POST /api/v1/spaces/{id}/roles`, `PATCH`/`DELETE .../roles/{role}`, `PUT .../roles/order` and `PUT .../members/{user}/roles`: a licensed space's own roles, ranked, with the four delegation rules |
| `role_preview` | enterprise edition | "Voir en tant que": a session looks at a space as one of its roles. While it does, the space (`GET /api/v1/me/spaces`) carries `preview` (`role_id`, `role_name`; `null` otherwise), `role` reads `member` (or `guest`), `my_permissions` and every list are those of that role (never more than the person really holds), every request that is not a `GET`, `HEAD` or `OPTIONS` answers `403 preview_read_only` (except leaving the preview and signing out), and the realtime transports (`/realtime/ws`, `/realtime/sse`) answer the same `403` to that session, whose app shows realtime as suspended. It ends on leaving, on sign out, or after 30 minutes without a request. The core carries the field and the refusals in every edition; the routes that start and end a preview are the enterprise edition's. An older app ignores `preview` and sees a smaller space |

A group mentioned by name (`@Comptabilité`) is stored as `group` in the message's mentions, and
reaches an older app as an ordinary mention notification (`kind` `mention`) with the text
unchanged: no new field, no new event.

An invitation may carry the end of a guest's access: `guest_expires_at` (RFC 3339, optional) on
`POST /api/v1/spaces/{id}/invitations` and on the invitation it returns. It is accepted only with
`role: "guest"` (`400 guest_only`), must lie ahead and within five years (`400 bad_expiry`), and is
copied to the guest when they join. An older app sends no such field and gets an invitation with no
end date, as before; an older instance ignores the field.

Two notices tell the people who manage a guest, and the guest, that access is ending:
`guest_expiry_soon` (to those who may manage the guest, 7 days then 1 day before) and
`guest_access_ending` (to the guest, the day before). They carry `space_id`, `space_name`,
`ends_at` (RFC 3339, UTC) and `days_left` (`7` or `1`), and `actor_id` and `actor_name` name the
guest for the first. They are **opt-in**: `GET /api/v1/notifications`, its `unread_count`, and
`PUT /api/v1/notifications/read` handle them only with `guest_notices=true`. Without it they are
left out of the list, not counted as unread (neither in the list nor in the `unread_count` of
`notification.read` and of the silent phone sync, which never count them), and not marked read
by "mark all read", so an app written before them never sees a kind it cannot draw nor a badge
it cannot clear. They have no live `notification.created` event and no push (`/push/pending`
leaves them out): an app that asked gets them on its next fetch. The app asks when the instance
lists the `guest_expiry` feature.

A guest's end date can be changed after they joined, by whoever may manage them (`members.manage`
and ranking above them; a guest never sets their own, a member never has one: `400 guest_only`):
`PUT /api/v1/spaces/{id}/members/{user}/expiry` with `{ "expires_at": ... }` answers the person
(`MemberDto`). The value is a date (`YYYY-MM-DD`, read as the end of that day in the SETTER's time
zone, as their `users.timezone` says) or an RFC 3339 instant, or `null` for no end; it must lie ahead,
within five years (`400 bad_expiry`). An ended access is not edited (`409 access_ended`). Moving or
removing the date starts the reminders over. `GET .../members/ended` lists the accesses that ended
and are still kept for ninety days (`user_id`, `display_name`, `title`, `ended_at`,
`days_left_to_keep`), soonest removal first, for `members.manage` only; `POST
.../members/{user}/reactivate` with the same body brings one back as it was (channels, groups and
roles are untouched; `409 not_ended` for anyone else, `409 access_ended_for_good` once ninety days have passed, as the list stops offering it). `PATCH .../members/{user}` accepts the same
`expires_at` with `role: "guest"`, applied in the same write. The space's member list adds `standing`
and `expires_at` to each person for those who manage people and for the person themself, and no one
else; `SpaceDto.expires_at` is the caller's own end. All are announced with `permissions.changed`
and audited (`member.expiry_set`, `member.reactivated`, each with `before` and `after`). An older
instance answers `404` and the app hides the controls; the `guest_expiry` feature covers these
routes as well as the notices.

The last two are the enterprise edition's own names, listed after the instance's by that build
only (`Edition::features`). What every instance of this version answers, whatever its edition,
needs no name: a space's `edition` and, for its owners, `licence`; `GET .../roles` and
`GET .../audit`; a member's `role_ids`, `manageable` and `joined_at` in the space's member list;
`pricing_url` here. An older instance answers `404` or leaves the fields out, and the apps read that
as the community edition with nothing to show.

Adding one: a name in `compat::FEATURES` (lowercase, underscores), a line in this table, and the
apps' check before they use it.

## The push relay

The relay serves every instance, whatever version each runs: its routes only grow too. An instance
newer than the relay (a `404` on `/v1/sync`) carries on without what is missing.
