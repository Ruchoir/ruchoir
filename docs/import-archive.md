# The import archive

Ruchoir imports a workspace from another product through **one archive format**, whatever the
product. The importer never learns a vendor's format: a producer (an export script we ship, or an
adapter that reads a vendor export) turns a source into this archive, and the importer reads only
this.

That indirection is the point. Adding a source means writing a producer; the importer, its
resumability, its idempotence and its screen do not change.

## Layout

A tar archive (sealed: see Encryption below), containing:

```
manifest.json          the archive describing itself
spaces.jsonl           one space per line
users.jsonl            one account per line
channels.jsonl         one conversation per line (channels and direct conversations)
messages.jsonl         one message per line, ordered by conversation then time
files.jsonl            one file per line, pointing into blobs/
blobs/<hh>/<hash>      file bytes, addressed by the SHA-256 of their content
```

JSON Lines, not one big JSON document: an import must stream. A workspace of several gigabytes is
read line by line and never held in memory, and a producer can append while it works.

**An archive can carry more than one space.** A Mattermost with two teams is two spaces, and
flattening them into one would merge two organisations that were deliberately apart. A source with
a single workspace still writes one `spaces.jsonl` line, so the importer never has two shapes to
handle.

Blobs are content-addressed and stored under the first two hex characters of their digest, so a
file attached to forty messages is stored once and a directory never holds a million entries.

## manifest.json

```json
{
  "format_version": 1,
  "source": "nextcloud",
  "source_version": "34.0.3 (Talk 24.0.4)",
  "producer": "ruchoir-export-nextcloud 0.1.0",
  "created_at": "2026-09-13T11:40:00Z",
  "counts": { "users": 6, "channels": 16, "messages": 92, "files": 388 },
  "checksums": { "users.jsonl": "sha256:...", "messages.jsonl": "sha256:..." },
  "limits": [
    "Nextcloud Talk has no call history export: calls appear as system messages only.",
    "Contacts and calendars are not imported: Ruchoir has nowhere to put them yet."
  ]
}
```

`limits` is not decoration. A producer states what it could not take, in plain language, and the
import screen shows those lines to the administrator **before** the run. An import that quietly
leaves things behind is the failure mode this whole feature exists to avoid.

`format_version` is refused rather than guessed at: an archive from a newer producer is rejected
with a message saying so.

## Records

Every conversation names the `space` it belongs to. A direct conversation belongs to the space its
participants shared, because a message between two people is not floating outside every workspace.

Every record carries an `id` **as the source spells it**, untouched. That identifier is what the
importer records in its mapping table, and what makes a re-run recognise its own work. Producers
never invent, renumber or prettify identifiers.

When a source has no single identifier for a thing, the producer builds a deterministic one out of
what the source does spell, and says how in the manifest. A Mattermost channel has no id in a bulk
export, only a team and a name, so it becomes `team/name`; a direct conversation becomes
`direct:` followed by its participants, sorted. Deterministic is the whole requirement: the same
export must yield the same identifier twice, or replaying it duplicates everything.

```json
// spaces.jsonl
{"id":"atelier","name":"Atelier","description":"","visibility":"public"}

// users.jsonl
{"id":"alice","email":"alice@example.org","display_name":"Alice Martin","active":true,"avatar":"sha256:..."}
// `avatar` is optional: a source that generates pictures rather than storing them has none to give.

// channels.jsonl
{"id":"atelier/general","space":"atelier","kind":"channel","name":"Général","topic":"…",
 "visibility":"public","archived":false,"members":["alice","bob"],"created_at":"2026-08-29T13:46:00Z"}
{"id":"direct:alice+bob","space":"atelier","kind":"direct","members":["alice","bob"]}

// messages.jsonl
{"id":"1042","channel":"fiddjs6o","author":"alice","sent_at":"2026-08-29T13:47:11Z",
 "body":"Bonjour **tout le monde**","format":"markdown","thread_root":null,"pinned":false,
 "edited_at":null,"reactions":[{"emoji":"tada","by":["bob"]}],"files":["emma/Documents/note.txt"]}

// a notice, not a sentence: `system_event` names the event and the reader's own language
// supplies the wording. One of member_joined, member_left, member_removed, channel_joined,
// channel_left, channel_removed, channel_created. `author` is the person the notice is ABOUT
// (who arrived), or null when it is about nobody, and `body` is empty.
{"id":"1041","channel":"fiddjs6o","author":"bob","sent_at":"2026-08-29T13:46:00Z","body":"",
 "system_event":"channel_joined"}

// files.jsonl
{"id":"7781","name":"note.txt","size":58,"content_type":"text/plain","hash":"sha256:…",
 "channel":"fiddjs6o","uploaded_by":"emma","uploaded_at":"2026-08-29T14:02:00Z"}
```

A producer emits a notice only for an event that has an equivalent here, and never invents a
sentence: an imported conversation that opens on neither its creation nor its arrivals reads as if
it had been cut, but a vendor's own phrasing in a Ruchoir thread is worse than no line at all.
Whatever it cannot map, it drops and declares.

Message bodies are Markdown, because that is what the product stores. A producer whose source uses
something else (Slack's `mrkdwn`, Mattermost's flavour) converts, and says so in `limits` if the
conversion loses anything.

A message's `files` holds the `id` of each attached file, exactly as `files.jsonl` spells it, not
the content hash: two accounts can hold the same bytes, and the attachment belongs to one of them.
The bytes are reached through that record's `hash`.

Mentions are the one thing a producer must not leave in vendor syntax: `<@U123>` means nothing here.
A mention is written as the source identifier of the person, in the form `@{id}`, and the importer
resolves it to a real account once the accounts are mapped.

## Encryption

An export is a complete copy of a company's conversations sitting in someone's downloads folder, so
the archive is sealed before it goes anywhere. Nothing in clear is a product rule, and it does not
stop at the database.

**OpenPGP symmetric encryption**, decided on 2026-09-13 for one reason: `gpg` is already on the
machine that runs a Nextcloud, and symmetric mode asks the administrator for a passphrase rather
than for key management. The producer seals, the import screen asks for the passphrase.

The layout above is tarred (no compression: gpg compresses, and doing it twice over gigabytes of
photographs and PDFs only costs time) and the tar is encrypted:

```
gpg --batch --symmetric --cipher-algo AES256 --digest-algo SHA512 \
    --s2k-mode 3 --s2k-count 65011712 \
    --passphrase-file <file> --output workspace.tar.gpg
```

The s2k parameters are the point of that command line: mode 3 with a high iteration count is what
makes a guessed passphrase expensive, and gpg's defaults are weaker than what an archive of this
value deserves.

A producer that generates the passphrase itself prints it once, at the end, and stores it nowhere.
An archive whose passphrase is lost is not recoverable, by us or by anyone: that is the property
being bought, and it is said in those words on screen rather than implied.

Reading it back: the importer opens the archive with `sequoia-openpgp` (German-governed, so it
clears the dependency rule) and streams the tar out of it without ever writing the clear archive to
disk. A wrong passphrase is reported as a wrong passphrase, never as a corrupt archive: the two
send an administrator down completely different roads.

## Producers

| Source | Producer | Where it runs |
| --- | --- | --- |
| Nextcloud | `packages/importer/export-nextcloud.sh`, shipped for administrators | On the Nextcloud host |
| Mattermost | Adapter over the bulk export (JSONL + attachments) | On the Ruchoir host |
| Slack | Adapter over the workspace export ZIP | On the Ruchoir host |
| Teams | Adapter over Microsoft Graph | On the Ruchoir host, against the tenant |

Nextcloud is the odd one out because Talk has no export at all: the script is the only way its
conversations come out, so we write and support it ourselves.
