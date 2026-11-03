# ADR 0009: One permission engine, Discord's model, names stored and bits in memory

- Status: accepted
- Date: 2026-11-03

## Context

A client asked for roles composed from atomic permissions, groups that carry roles, delegated
administration per space and restricted guest access, and the same model has to carry rules on
channels, folders, files and calendars later. Until now, rights were four fixed space roles
(`owner`, `admin`, `member`, `guest`) and three channel roles, compared as strings at about fifty
call sites across messaging, files, calendars and office, with a reservation table
(`channel_role_access`) and a calendar setting (`write_access`) on the side. Each domain already had
a single choke point, which is what made a replacement possible without rewriting handlers.

Three constraints:

1. Behaviour must not change while the model does: the first step ships to people using it daily.
2. `/api/v1` only grows (`docs/api-compatibility.md`), and installed apps that were not updated must
   keep working.
3. The previous image must be able to restart on the same data (a rollback).

## Decision

**Discord's model.** A person's *standing* in a space (`owner`, `member`, `guest`) is not a role: an
owner holds every permission and stands outside every rule; a guest stays under a hard ceiling no
rule lifts. Space roles only add (`@members` or `@guests`, implied by the standing, plus the roles
held, the system role Administrator among them). Rules on a resource allow or deny permissions for a
role or a person, level by level from the space down to the resource, and the level closest to the
resource wins; within a level, rules on the base role come first, then the union of the roles'
rules, then the person's. A few facts stay facts, not rules: a private channel is entered by joining
it, an archived channel is read only (for its owner too), a file's author manages it, a calendar
event lets whoever sees it read the files it carries.

**One engine.** `apps/api/src/permissions/` holds the catalogue (29 named permissions,
`family.action`), a pure resolution function that also explains itself (every step that granted or
removed a permission, with its source), a loader that reads a whole space's people and a list's rules
in a fixed number of queries, and the check API every handler calls (`can`, `effective`,
`effective_many`, `holders`, `explain`). Real-time audiences go through it too: a channel's frames
reach its members who still read it.

**Names stored, bits in memory.** A role or a rule stores permission names (`text[]`); in memory a
set is a `u64`. A name is never renamed or removed and its bit never moves
(`the_permission_catalogue_only_grows` holds it against `apps/api/contract/permissions-v1.json`);
an unknown name, written by a newer version before a rollback, is ignored and can open nothing.

**The old columns stay the written ones for now, and the database derives the new model from
them.** Triggers turn every write of `space_members.role`, `channel_role_access` and
`calendars.write_access` into the standing, the Administrator role and the rules, and give each new
space its system roles. Whoever writes (this version, the previous image after a rollback, the
importer, the seed), the two models cannot drift apart. Clients keep their `role` field and gain
`my_permissions` (announced by the `permissions` feature) and `permissions.changed`.

The first step (permissions lot 1) was held to the old rules by a parity test: the old functions,
copied verbatim, compared with the engine over every combination of role, channel type, reservation,
membership, channel role, file location and authorship, and calendar setting.

## Consequences

- One place decides; a new right is a new name in the catalogue, off everywhere except where its
  migration states its value in the system roles.
- "Why may they?" is the same function as the decision, so the explanation cannot disagree with it.
- Custom roles, groups, resource rules and guest settings (later lots) are data for an engine that
  already evaluates them, not new code paths.
- Once rights are granted directly (custom roles), the code must keep writing the old `role` column
  (derived: owner, else `admin` when holding Administrator, else `guest`, else `member`) for as long
  as rollback to a pre-engine image matters.

## Alternatives rejected

- **A pure bitfield stored as an integer.** Compact, but a bit's meaning lives only in code: a
  rollback or a reordering silently hands one right's holders another, and the database cannot be
  read by a person.
- **An external policy engine** (Zanzibar-style services, OPA). Another service to run and secure
  for a model this small, a network hop on every check, and most are not European.
- **Converting in Rust only (dual writes in every handler).** It leaves the previous image, the
  importer and every direct write free to update the old columns alone, after which the new model is
  wrong without anyone noticing.
