# AGENTS.md - packages/importer

The zero-loss import tooling: the official Ruchoir export scripts (run by the customer on their own
Nextcloud or Mattermost server) plus the adapters that turn a vendor export into a Ruchoir archive.
This is the product's signature feature. See the root `AGENTS.md` for project-wide rules.

## Status

In progress. The archive format is written down (`docs/import-archive.md`), the job and mapping
tables exist (`import_jobs`, `import_mappings`), and two producers are here and verified against
real instances: Nextcloud and Mattermost. The importer that consumes an archive is not written yet,
and neither are the Slack and Teams adapters. The SeaORM entities land with the code that reads
them, not before: an entity nothing calls is dead weight, and the compiler says so.

## Contents

- `convert-mattermost.py` : reads a Mattermost bulk export (`mmctl export create`) and writes the
  archive. Runs on our host, on an export the customer hands over. Python rather than shell: the
  export is nested JSON with threads inside their root post, which jq turns into something nobody
  will ever review.
- `export-nextcloud.sh` : runs on the Nextcloud host, reads the database and the data directory,
  writes a sealed Ruchoir archive. Nextcloud Talk has no export of its own, which is why we ship
  one. Read-only: it never writes to the source instance. Sealing is OpenPGP symmetric through
  `gpg`; a generated passphrase is printed once and stored nowhere.

## Principles

- **One archive format, many producers.** Our export scripts and our adapters produce the format in
  `docs/import-archive.md`; the importer consumes only that. No source-API scraping in the importer,
  and adding a source never changes it.
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
