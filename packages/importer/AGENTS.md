# AGENTS.md - packages/importer

The zero-loss import tooling: the official Ruchoir export scripts (run by the customer on their own
Nextcloud or Mattermost server) plus the adapters that turn a vendor export, or a vendor's API, into
a Ruchoir archive.
This is the product's signature feature. See the root `AGENTS.md` for project-wide rules.

## Status

In progress. The archive format is written down (`docs/import-archive.md`), the job and mapping
tables exist (`import_jobs`, `import_mappings`), and four producers are here: Nextcloud and
Mattermost, verified against real servers, Slack, written against a real workspace export, and
Teams, written against the Microsoft Graph documentation and a Graph of our own on localhost, and
**not yet run against a real tenant**. The SeaORM entities land with the code that reads
them, not before: an entity nothing calls is dead weight, and the compiler says so.

## Contents

- `convert-mattermost.py` : reads a Mattermost bulk export (`mmctl export create`) and writes the
  archive. Runs on our host, on an export the customer hands over. Python rather than shell: the
  export is nested JSON with threads inside their root post, which jq turns into something nobody
  will ever review.
- `make-load-archive.py` : writes a generated archive of any size, to run the importer against
  something the shape of a real migration rather than a six-account fixture. Its `source` is
  `synthetic` rather than a borrowed product name, because the source is written into every mapping
  a run records. Deterministic: the same seed gives the same bytes, so a failure at 120 000 messages
  can be reproduced instead of described.
- `make-demo-archive.py` : writes a small archive carrying one of everything the format allows -
  a thread, a pinned message, an edit, a reaction, a saved message, a favourite, a reading position,
  an attachment of each kind, every notice, an archived conversation, a deactivated account, an
  account with no address, an absent author and a mention. Its sibling above answers "does this
  survive a real migration"; this one answers "does every feature actually arrive", and it is what
  to import when a screen has to be looked at rather than a counter.
- `convert-slack.py` : reads a Slack workspace export (the ZIP an owner downloads from Settings ->
  Import/Export Data -> Export) and writes the archive. A standard export carries public channels
  only, and no option changes that; `--with-private` reads the private channels a token's owner
  belongs to from the API instead, which is the only way to reach them short of a compliance
  export. Direct messages stay out: they need their own scopes and a decision about whose
  conversations a migration may carry. The only producer that reaches the network:
  a Slack export carries links to its files rather than the files, and the export signs those links
  itself, so the ordinary conversion downloads them without asking the customer for anything. That
  signature dies with the export (Slack deletes one ten days after download), and only then does
  the converter stop and print how to make a `files:read` token for `--token-file`. Reaching
  files.slack.com is a one-off migration step a customer asked for, not a runtime dependency, and
  this script is the only thing in the product that does it.
- `convert-teams.py` : reads a Microsoft Teams organisation through Microsoft Graph and writes the
  archive. Teams has no export to hand over, so this is the one producer that is an API client from
  end to end, signing in as an application the customer registers in their own Entra ID with seven
  read-only permissions (`--help-app` prints them and the steps). Each team becomes a space, each
  channel a conversation (private and shared ones private, with their own members), and each team's
  document library lands in its space's files, folders kept, except what was posted in a message,
  which travels with the message. Chats are left in Teams by decision (2026-09-24), and so are
  private channels' libraries, whose files would otherwise be shown to the whole space. Everything
  Graph answers is kept in a cache directory, so a read that stops after hours resumes when run
  again; the cache holds the conversations in clear, is created readable by its owner only, and
  the delivery script removes it once the archive is delivered. The token is sent to Graph and the
  sign-in service only: a file's bytes are served from a signed SharePoint address it redirects to,
  fetched without it.
- `export-nextcloud.sh` : runs on the Nextcloud host, reads the database and the data directory,
  writes a sealed Ruchoir archive. Nextcloud Talk has no export of its own, which is why we ship
  one. Read-only: it never writes to the source instance. Sealing is OpenPGP symmetric through
  `gpg`; a generated passphrase is printed once and stored nowhere.

## Tests

`cd packages/importer/tests && python3 -m unittest discover`. No dependencies beyond the standard
library: the suite has to be runnable by anyone who checks the repo out, without a virtualenv.

The Nextcloud producer needs a real MariaDB, because its risky half is SQL and SQL cannot be tested
by reading it. Point the suite at one and it runs; leave the variable unset and it skips, loudly:

```
RUCHOIR_TEST_MARIADB=host=127.0.0.1,port=3306,user=root,password=secret python3 -m unittest discover
```

CI runs it against a MariaDB service with `RUCHOIR_TEST_REQUIRE_MARIADB=1`, which turns a skipped
producer test into a failure. A suite that quietly skips its only end-to-end test reports green
over an untested feature, which is worse than having no suite.

### The rehearsal against real servers

`packages/importer/e2e/run.sh` stands up a real Nextcloud with Talk and a real Mattermost in
Docker, fills them through their own APIs, and takes an export from each by the commands the
import screen tells a customer to run: `export-nextcloud.sh` on the Nextcloud host, `mmctl export
create` then `convert-mattermost.py` for Mattermost. It leaves two sealed archives and the servers
up; `run.sh down` puts it all away.

This is not the same question as the suite above. The tests ask whether a producer reads its
source correctly, against an archive we wrote. The rehearsal asks whether a customer's export
opens in Ruchoir, and it has answered no three times, on defects no generated archive could show:
a SQL comment whose backticks made the shell run words as commands on the Nextcloud host, a data
directory belonging to a deleted account (Nextcloud keeps it; the export named an owner no account
carried, and the archive failed the contract checker at import time, in front of the customer),
and a direct conversation written `members` rather than `participants` by older servers, which
produced a conversation with nobody in it.

It is not part of `unittest discover`: it needs docker, sudo and several minutes. Run it when a
producer changes, and before promising anyone that an import works.

**Slack cannot join it**, because there is no Slack to run: the only real export comes from a real
workspace. `convert-slack.py` was written against one (export format 2, September 2026) and its
fixtures are shaped like what that export actually held, down to the escaping inside a code
snippet. The export itself is deliberately absent from the repository: it holds somebody's real
messages and files. When Slack changes its format, the way to find out is another real export, not
a reading of the documentation.

**Teams cannot join it either**, and has no real export behind it yet: `convert-teams.py` was
written from the Graph documentation, and its tests run it against a Graph of our own on localhost
(`tests/test_convert_teams.py`) that answers with the documentation's own shapes, down to the
notices, the replies behind a second page and the redirect a download takes. That checks the wire
(the token reaches Graph and nothing else, a throttled call waits as long as it is told) and the
conversion, not whether Graph really answers that way. A trial Microsoft 365 tenant is the way to
find out, and until one has been read, the Teams import is a rehearsal rather than a promise.

The API half (`--with-private`) has no real workspace behind its tests either: the calls are stood
in for, except one test that runs a server on localhost and checks what actually goes over the wire
(path, query, bearer token, cursor). The first real private channel it reads will be somebody's,
and that is worth knowing before promising it.

**The contract has two implementations, and they must agree.** This one runs beside a producer, on
the customer's machine, so that nobody carries a broken archive across the internet only to be
refused on arrival. The one inside the API decides whether an archive is actually imported. That
promise is worth exactly as much as the agreement between the two, and it has been worth nothing
twice: a rule that existed only in the API let a producer ship an archive the API then refused
whole. `tests/test_checkers_agree.py` puts the same archives to both and requires the same verdict,
so a rule added on one side fails at the moment it is written. It needs the API binary
(`cargo build -p ruchoir-api`); CI builds one and treats a skip as a failure.

`validate-archive.py` is the contract checker. Every producer's test ends by running it over the
output, so an adapter cannot ship an archive the importer would refuse.

## Running an import

`ruchoir-api import <archive> <administrator address> [passphrase]` runs the whole thing from a file
already on the server: the path for an archive too large to upload, on a machine the administrator
already has a shell on. The address is asked for rather than guessed, because whoever runs the
import owns every space it creates.

Running it twice is how a failed import is resumed: every pass recognises what it already wrote.

### Who may import (decided 2026-09-23)

The command line is for administrators of the instance. The import screen is open to anyone signed
in, and everybody who does not administer the instance is **scoped** (`Existing::scoped` in
`apps/api/src/importer/plan.rs`):

- They see and import only the archives their own delivery commands dropped (a delivered archive is
  named `drop-<owner>-<id>.tar.gpg`), and only their own jobs.
- Their import only ever **creates** spaces, owned by them. It never fills a space by name.
- It reaches no other account. Their own address is matched; every other address in the archive is
  withheld, so those people arrive with an `@import.invalid` address. Matching would pour messages
  into a stranger's account, and a waiting account holding a real address locks that person out of
  registering (only an invitation can claim it).
- Their correspondences live in their own namespace (`import_mappings.owner_id`), so an archive that
  spells the same source identifiers as somebody else's import never resolves to that import's rows.
- Emptying the instance first (`replace_everything`) and writing invitations to the imported people
  stay with the administrators.

## The other end

`ruchoir-api import-check <archive> [passphrase]` reads an archive and reports what would be
imported and whether it holds together, without touching the database. It accepts a sealed archive,
a clear tar, or an unpacked directory, and it is the same contract this package's
`validate-archive.py` enforces, applied by the code that will do the importing.

Use it after producing an export: it costs nothing and it is the difference between finding a
problem now and finding it after uploading sixty gigabytes.

## Principles

- **One archive format, many producers.** Our export scripts and our adapters produce the format in
  `docs/import-archive.md`; the importer consumes only that. No source-API scraping in the importer,
  and adding a source never changes it.
- **Write the Markdown the product reads, not CommonMark.** The message reader
  (`apps/web/features/channel/richText.tsx`) takes `**bold**`, `_italic_` (one asterisk is not
  italic), `~~struck~~`, backticks, fences, `## ` headings and up (one `#` is a channel), `- ` and
  `1. ` lists with no nesting, `> ` quotes and bare links. It has no `[text](address)` and no
  backslash escapes: a named link must cross as "text (address)", or it arrives as brackets.
- **Import is transactional and idempotent.** An interrupted import leaves no half-populated
  conversation; re-running an archive imports nothing twice. That property rests on
  `import_mappings`, written in the same transaction as the row it points at, not on heuristics.
- **A producer declares what it could not take.** The `limits` list in the manifest is shown to the
  administrator before the run. An import that quietly leaves things behind is the failure this
  feature exists to prevent.
- **Archives may contain secrets** (server config, password hashes): never log them in clear, never
  expose them to the client, purge them after the import.
- **Run it before believing it.** Both producers were written from the schema and both were wrong
  until an instance was stood up: Mattermost's bulk export carries private channels and direct
  messages (the opposite of what is commonly said) and silently drops archived channels, and the
  Nextcloud reader was destroying every emoji through a utf8mb3 connection. The counts an export
  prints are the cheapest bug detector there is.
- Develop and test against the real fixtures (local, gitignored): `fixtures/nextcloud-seed/` and
  `fixtures/mattermost-seed/` stand the sources up, and the archives they produce are kept as
  `fixtures/export-nextcloud-<date>/` and `fixtures/archive-mattermost-<date>/`.
