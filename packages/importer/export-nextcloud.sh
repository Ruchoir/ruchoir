#!/usr/bin/env bash
# Exports a Nextcloud (Talk conversations, accounts and files) into a Ruchoir import archive.
#
# Nextcloud Talk has no export of its own, so this script is the only way those conversations come
# out. It runs on the Nextcloud host, reads the database directly and copies file bytes out of the
# data directory, and writes the archive described in ../../docs/import-archive.md.
#
# It only reads. Nothing is written to the Nextcloud instance.
#
#   packages/importer/export-nextcloud.sh --data-dir /var/www/html/data --out /tmp/nextcloud-export
#
# Database credentials are read from the environment (see --help), or from the instance's own
# config.php when --config is given, which is the usual case.
set -euo pipefail

PREFIX="oc_"
SPACE_NAME="Nextcloud"
DATA_DIR=""
OUT=""
CONFIG=""
DB_HOST="${NC_DB_HOST:-localhost}"
DB_NAME="${NC_DB_NAME:-nextcloud}"
DB_USER="${NC_DB_USER:-}"
DB_PASS="${NC_DB_PASS:-}"
DOCKER_DB=""
PASSPHRASE_FILE=""
ENCRYPT=1

usage() {
  cat <<'USAGE'
Usage: export-nextcloud.sh --data-dir <path> --out <path> [options]

  --data-dir <path>   Nextcloud data directory (holds one directory per account).
  --out <path>        Directory to write the archive into. Created if absent.
  --config <path>     Read database credentials from a Nextcloud config.php.
  --prefix <s>        Table prefix (default: oc_).
  --space-name <s>    Name of the space the conversations land in (default: Nextcloud).
  --docker-db <name>  Run the MySQL client inside this container instead of on the host.
  --passphrase-file <path>
                      Encrypt with the passphrase in this file instead of a generated one.
  --no-encrypt        Leave the archive in clear. For local development only: an export is a
                      complete copy of a company's conversations.

Without --config, credentials come from NC_DB_HOST, NC_DB_NAME, NC_DB_USER, NC_DB_PASS.
Only MySQL and MariaDB are supported for now; a PostgreSQL Nextcloud needs the same queries
against psql, which is a small change once someone runs one.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --config) CONFIG="$2"; shift 2 ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    --space-name) SPACE_NAME="$2"; shift 2 ;;
    --docker-db) DOCKER_DB="$2"; shift 2 ;;
    --passphrase-file) PASSPHRASE_FILE="$2"; shift 2 ;;
    --no-encrypt) ENCRYPT=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[ -n "${DATA_DIR}" ] && [ -n "${OUT}" ] || { usage >&2; exit 2; }
[ -d "${DATA_DIR}" ] || { echo "no such data directory: ${DATA_DIR}" >&2; exit 1; }
command -v sha256sum >/dev/null || { echo "export-nextcloud.sh needs sha256sum" >&2; exit 1; }
[ "${ENCRYPT}" -eq 0 ] || command -v gpg >/dev/null || {
  echo "export-nextcloud.sh needs gpg to encrypt the archive (or pass --no-encrypt)" >&2; exit 1; }

# Credentials straight out of config.php, which is where an administrator expects us to look.
if [ -n "${CONFIG}" ]; then
  [ -r "${CONFIG}" ] || { echo "cannot read ${CONFIG}" >&2; exit 1; }
  read_cfg() { php -r "\$CONFIG=[]; require '${CONFIG}'; echo \$CONFIG['$1'] ?? '';"; }
  command -v php >/dev/null || { echo "--config needs php on this host" >&2; exit 1; }
  DB_HOST="$(read_cfg dbhost)"; DB_NAME="$(read_cfg dbname)"
  DB_USER="$(read_cfg dbuser)"; DB_PASS="$(read_cfg dbpassword)"
  PREFIX="$(read_cfg dbtableprefix)"; PREFIX="${PREFIX:-oc_}"
fi
[ -n "${DB_USER}" ] || { echo "no database user: pass --config or set NC_DB_USER" >&2; exit 1; }

# Recent MariaDB releases ship `mariadb` and no longer symlink `mysql`, while a MySQL host only
# has `mysql`. Pick whichever is there rather than making the administrator care.
if [ -n "${DOCKER_DB}" ]; then
  if docker exec "${DOCKER_DB}" sh -c 'command -v mariadb' >/dev/null 2>&1; then
    CLIENT=mariadb
  elif docker exec "${DOCKER_DB}" sh -c 'command -v mysql' >/dev/null 2>&1; then
    CLIENT=mysql
  else
    echo "no mariadb or mysql client inside ${DOCKER_DB}" >&2; exit 1
  fi
elif command -v mariadb >/dev/null 2>&1; then
  CLIENT=mariadb
elif command -v mysql >/dev/null 2>&1; then
  CLIENT=mysql
else
  echo "export-nextcloud.sh needs a mariadb or mysql client" >&2; exit 1
fi

# One line per row, tabs stripped of their escaping by --raw, and no column headers.
# `--default-character-set=utf8mb4` is not optional: without it the connection negotiates utf8mb3
# and every four-byte character comes back as a question mark. That silently destroys emoji, in
# reactions and in message bodies alike, which on a chat export is real data loss.
sql() {
  if [ -n "${DOCKER_DB}" ]; then
    docker exec -i "${DOCKER_DB}" "${CLIENT}" --batch --raw --skip-column-names \
      --default-character-set=utf8mb4 \
      -h localhost -u "${DB_USER}" -p"${DB_PASS}" "${DB_NAME}"
  else
    "${CLIENT}" --batch --raw --skip-column-names --default-character-set=utf8mb4 \
      -h "${DB_HOST}" -u "${DB_USER}" -p"${DB_PASS}" "${DB_NAME}"
  fi
}

# A client that fails can still print its complaint on standard output, which lands in the file we
# were filling. A half-written archive that looks plausible is worse than no archive, so every
# generated file is checked to be what it claims before the next step runs.
expect_jsonl() {
  local path="$1"
  if [ -s "${path}" ] && ! head -c1 "${path}" | grep -q '{'; then
    echo "the database client wrote something that is not JSON into $(basename "${path}"):" >&2
    head -2 "${path}" >&2
    exit 1
  fi
}

mkdir -p "${OUT}/blobs"
echo "exporting into ${OUT}"

# --- Space ------------------------------------------------------------------------------------
# Nextcloud has no team or workspace: everything belongs to one instance, so the archive carries a
# single space. Mattermost, which does have teams, carries one line per team, and the importer
# reads both the same way.
echo "  space"
printf '%s\n' "$(python3 -c 'import json,sys; print(json.dumps({"id":"nextcloud","name":sys.argv[1],"description":"","visibility":"private"}, ensure_ascii=False))' "${SPACE_NAME}")" \
  > "${OUT}/spaces.jsonl"
expect_jsonl "${OUT}/spaces.jsonl"

# --- Accounts ------------------------------------------------------------------------------------
# Talk identifies people by their Nextcloud uid, so the uid is the identifier the archive carries
# and the importer maps. The address is what the import matches on.
echo "  accounts"
sql > "${OUT}/users.jsonl" <<SQL
SELECT JSON_OBJECT(
  'id', u.uid,
  'email', COALESCE(JSON_VALUE(a.data, '\$.email.value'), ''),
  'display_name', COALESCE(u.displayname, u.uid),
  'active', IF(COALESCE(p.configvalue, 'true') = 'false', FALSE, TRUE)
)
FROM ${PREFIX}users u
LEFT JOIN ${PREFIX}accounts a ON a.uid = u.uid
LEFT JOIN ${PREFIX}preferences p
  ON p.userid = u.uid AND p.appid = 'core' AND p.configkey = 'enabled'
ORDER BY u.uid;
SQL
expect_jsonl "${OUT}/users.jsonl"

# --- Conversations -------------------------------------------------------------------------------
# Talk room types: 1 one-to-one, 2 group, 3 public, 4 changelog, 5 former one-to-one,
# 6 note to self. Those last three, plus the `sample` conversations Talk installs for every new
# account, are Nextcloud's own furniture rather than the customer's conversations: they are left
# out here and declared in the manifest's limits. Importing them would hand a company a workspace
# that opens on somebody else's welcome message.
echo "  conversations"
sql > "${OUT}/channels.jsonl" <<SQL
SELECT JSON_OBJECT(
  'id', r.token,
  'space', 'nextcloud',
  'kind', IF(r.type = 1, 'direct', 'channel'),
  -- A one-to-one has no name of its own: Talk stores the participant list in that column, as
  -- JSON, and copying it through would name the conversation ["bob","carol"] forever. A direct
  -- conversation is named by who is in it, at the far end, in the reader's own language.
  'name', IF(r.type = 1, '', COALESCE(NULLIF(r.name, ''), r.token)),
  'topic', COALESCE(r.description, ''),
  'visibility', IF(r.type = 3, 'public', 'private'),
  -- Talk has no archived conversation: `archived` is a per-participant setting on the attendee
  -- row, so "this conversation is archived" is not a fact the source holds. Declared in limits.
  'archived', FALSE,
  'members', COALESCE((
    SELECT JSON_ARRAYAGG(att.actor_id)
    FROM ${PREFIX}talk_attendees att
    WHERE att.room_id = r.id AND att.actor_type = 'users'
  ), JSON_ARRAY()),
  -- What each person kept about this conversation: a favourite, a reading position. Only the
  -- people who have something to say appear, so a roster of six with one favourite is one entry.
  -- Talk names the last message read, which is more precise than a moment and needs no guessing
  -- at the other end.
  'member_state', COALESCE((
    -- JSON_REMOVE drops the key rather than writing `false`: an entry says what someone kept,
    -- and a list of six `favorite: false` says nothing while looking like it does.
    SELECT JSON_ARRAYAGG(JSON_REMOVE(
      JSON_OBJECT(
        'user', att.actor_id,
        'favorite', TRUE,
        'read_message', CAST(att.last_read_message AS CHAR)
      ),
      IF(att.favorite = 1, '\$.absent', '\$.favorite')
    ))
    FROM ${PREFIX}talk_attendees att
    WHERE att.room_id = r.id
      AND att.actor_type = 'users'
      AND (att.favorite = 1 OR COALESCE(att.last_read_message, 0) > 0)
  ), JSON_ARRAY()),
  'created_at', DATE_FORMAT(COALESCE(r.active_since, r.last_activity), '%Y-%m-%dT%H:%i:%sZ')
)
FROM ${PREFIX}talk_rooms r
WHERE r.type IN (1, 2, 3)
  AND COALESCE(r.object_type, '') NOT IN ('changelog', 'note_to_self', 'sample')
ORDER BY r.id;
SQL
expect_jsonl "${OUT}/channels.jsonl"

# --- Messages ------------------------------------------------------------------------------------
# Talk stores its chat in oc_comments, keyed by the room's numeric id. `verb` separates what people
# wrote ('comment') from what the system narrated ('system').
#
# Both are kept, for different reasons. 'object_shared' is how a shared file appears in the
# conversation, and dropping it would lose the file from the thread it belongs to. A 'system' row
# is a notice, and Ruchoir has notices of its own, written in the reader's language: an imported
# conversation that opens with neither its creation nor its arrivals reads as if it had been cut.
# Only the two events that have an equivalent here cross, as an event name and never as a phrase.
#
# `parent_id` is a reply, which is the closest thing Talk has to our thread root.
#
# Messages written by someone who is not an account (a guest in a public conversation, a bot) are
# kept, with the author spelled `<actor_type>:<id>` so the importer can recognise that no account
# will ever match it. Filtering them out here would be a silent loss, which is the one thing this
# chain is not allowed to do.
#
# Three things Talk does not keep where you would look for them:
#   - who reacted is in oc_reactions; oc_comments.reactions only counts them, so the counts are
#     ignored and the real thing is rebuilt from the rows.
#   - whether a message is pinned is a `pinned_at` key inside the comment's meta_data JSON.
#   - a shared file is a share id inside the message JSON, resolved through oc_share and
#     oc_filecache into the same `<account>/<path>` identifier that files.jsonl carries.
echo "  messages"
sql > "${OUT}/messages.jsonl" <<SQL
SELECT JSON_OBJECT(
  'id', CAST(c.id AS CHAR),
  'channel', r.token,
  -- A notice is about someone rather than written by them, so an arrival carries the person who
  -- arrived, not the person who added them. A conversation's creation is about nobody.
  'author', CASE
    WHEN c.verb = 'system' AND JSON_VALUE(c.message, '\$.message') = 'user_added'
      THEN JSON_VALUE(c.message, '\$.parameters.user')
    WHEN c.verb = 'system' THEN NULL
    WHEN c.actor_type = 'users' THEN c.actor_id
    ELSE CONCAT(c.actor_type, ':', c.actor_id)
  END,
  'sent_at', DATE_FORMAT(c.creation_timestamp, '%Y-%m-%dT%H:%i:%sZ'),
  -- A file share and a notice both carry a JSON envelope, not a sentence.
  'body', IF(c.verb IN ('object_shared', 'system'), '', COALESCE(c.message, '')),
  -- Set only on a notice, and only for the two Talk events that have an equivalent here. The
  -- sentence is ours, in the reader's language; the archive carries the event, never a phrase.
  'system_event', CASE JSON_VALUE(c.message, '\$.message')
    WHEN 'conversation_created' THEN IF(c.verb = 'system', 'channel_created', NULL)
    WHEN 'user_added' THEN IF(c.verb = 'system', 'channel_joined', NULL)
    ELSE NULL
  END,
  'format', 'markdown',
  'thread_root', IF(c.parent_id = 0, NULL, CAST(c.parent_id AS CHAR)),
  'pinned', JSON_VALUE(c.meta_data, '\$.pinned_at') IS NOT NULL,
  'edited_at', NULL,
  -- The derived table groups every reaction in one pass and the correlation happens outside it:
  -- MariaDB does not allow a correlated reference inside a derived table.
  -- JSON_EXTRACT(..., '\$') parses the text back into a JSON value. MariaDB has no
  -- CAST(x AS JSON), and without the parse the array would be embedded as a quoted string.
  'reactions', JSON_EXTRACT(COALESCE((
    -- Ordered so two exports of the same instance produce byte-identical files, which is what
    -- makes an archive diffable and a checksum meaningful.
    SELECT CONCAT('[', GROUP_CONCAT(
      JSON_OBJECT('emoji', g.reaction, 'by', g.actors) ORDER BY g.reaction SEPARATOR ','
    ), ']')
    FROM (
      SELECT rx.parent_id,
             rx.reaction,
             JSON_ARRAYAGG(
               IF(rx.actor_type = 'users', rx.actor_id, CONCAT(rx.actor_type, ':', rx.actor_id))
               ORDER BY rx.actor_id
             ) AS actors
      FROM ${PREFIX}reactions rx
      GROUP BY rx.parent_id, rx.reaction
    ) g
    WHERE g.parent_id = c.id
  ), '[]'), '\$'),
  'files', COALESCE((
    SELECT JSON_ARRAYAGG(CONCAT(SUBSTRING(st.id, 7), '/', SUBSTRING(fc.path, 7)))
    FROM ${PREFIX}share sh
    JOIN ${PREFIX}filecache fc ON fc.fileid = sh.file_source
    JOIN ${PREFIX}storages st ON st.numeric_id = fc.storage
    WHERE c.verb = 'object_shared'
      AND sh.id = JSON_VALUE(c.message, '\$.parameters.share')
      AND st.id LIKE 'home::%'
      AND fc.path LIKE 'files/%'
  ), JSON_ARRAY())
)
FROM ${PREFIX}comments c
JOIN ${PREFIX}talk_rooms r ON r.id = CAST(c.object_id AS UNSIGNED)
WHERE c.object_type = 'chat'
  AND (
    c.verb IN ('comment', 'object_shared')
    -- Talk narrates a dozen kinds of event; only these two have an equivalent here. A moderator
    -- promotion has no notice of its own, and pinning and deletion are already carried by the
    -- message itself, so importing them would say the same thing twice. Declared in limits.
    OR (c.verb = 'system'
        AND JSON_VALUE(c.message, '\$.message') IN ('conversation_created', 'user_added'))
  )
  AND r.type IN (1, 2, 3)
  AND COALESCE(r.object_type, '') NOT IN ('changelog', 'note_to_self', 'sample')
ORDER BY r.id, c.creation_timestamp, c.id;
SQL
expect_jsonl "${OUT}/messages.jsonl"

# --- Files ---------------------------------------------------------------------------------------
# Read from the data directory rather than from oc_filecache: the cache describes what Nextcloud
# believes it has, the directory holds what it actually has, and an import that silently drops a
# file is exactly what this feature exists to avoid. Trash, versions and per-app data are skipped.
echo "  files (hashing as we go, this is the slow part)"
# One python3 pass rather than a shell loop: it hashes, de-duplicates, copies and writes the JSON
# in one go, and correct JSON escaping is free instead of being seven subprocesses per file.
FILE_COUNT="$(python3 - "${DATA_DIR}" "${OUT}" <<'PYEOF'
import hashlib, json, mimetypes, os, shutil, sys
from datetime import datetime, timezone

data_dir, out = sys.argv[1], sys.argv[2]
skip_prefixes = ("appdata_", "updater-")
skip_names = {"files_external", "__groupfolders"}

def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

count = 0
with open(os.path.join(out, "files.jsonl"), "w", encoding="utf-8") as sink:
    for account in sorted(os.listdir(data_dir)):
        root = os.path.join(data_dir, account, "files")
        if not os.path.isdir(root) or account in skip_names:
            continue
        if account.startswith(skip_prefixes):
            continue
        for dirpath, _, filenames in os.walk(root):
            for name in sorted(filenames):
                path = os.path.join(dirpath, name)
                if not os.path.isfile(path) or os.path.islink(path):
                    continue
                h = digest(path)
                dest = os.path.join(out, "blobs", h[:2], h)
                if not os.path.exists(dest):
                    os.makedirs(os.path.dirname(dest), exist_ok=True)
                    shutil.copy2(path, dest)
                stat = os.stat(path)
                rel = os.path.relpath(path, root)
                sink.write(json.dumps({
                    "id": f"{account}/{rel}",
                    "name": name,
                    "path": rel,
                    "size": stat.st_size,
                    "content_type": mimetypes.guess_type(name)[0] or "application/octet-stream",
                    "hash": f"sha256:{h}",
                    "channel": None,
                    "uploaded_by": account,
                    "uploaded_at": datetime.fromtimestamp(stat.st_mtime, timezone.utc)
                        .strftime("%Y-%m-%dT%H:%M:%SZ"),
                }, ensure_ascii=False) + "\n")
                count += 1
print(count)
PYEOF
)"

# --- Manifest ------------------------------------------------------------------------------------
echo "  manifest"
count() { wc -l < "$1" | tr -d ' '; }
digest() { printf 'sha256:%s' "$(sha256sum "$1" | cut -d' ' -f1)"; }
# Talk's version lives in the database; Nextcloud's own lives in config.php, so it is only known
# when the administrator pointed us at one. Saying "unknown" is better than printing a guess into
# something the importer will read back.
TALK_VERSION="$(sql <<SQL || echo '?'
SELECT COALESCE(MAX(configvalue), '?') FROM ${PREFIX}appconfig
WHERE appid = 'spreed' AND configkey = 'installed_version';
SQL
)"
NC_CORE_VERSION="unknown"
if [ -n "${CONFIG}" ]; then
  NC_CORE_VERSION="$(read_cfg version)"
  NC_CORE_VERSION="${NC_CORE_VERSION:-unknown}"
fi
NC_VERSION="Nextcloud ${NC_CORE_VERSION} (Talk ${TALK_VERSION})"

cat > "${OUT}/manifest.json" <<JSON
{
  "format_version": 1,
  "source": "nextcloud",
  "source_version": $(printf '%s' "${NC_VERSION}" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read().strip()))'),
  "producer": "ruchoir-export-nextcloud 0.1.0",
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "counts": {
    "spaces": 1,
    "users": $(count "${OUT}/users.jsonl"),
    "channels": $(count "${OUT}/channels.jsonl"),
    "messages": $(count "${OUT}/messages.jsonl"),
    "files": ${FILE_COUNT}
  },
  "checksums": {
    "spaces.jsonl": "$(digest "${OUT}/spaces.jsonl")",
    "users.jsonl": "$(digest "${OUT}/users.jsonl")",
    "channels.jsonl": "$(digest "${OUT}/channels.jsonl")",
    "messages.jsonl": "$(digest "${OUT}/messages.jsonl")",
    "files.jsonl": "$(digest "${OUT}/files.jsonl")"
  },
  "limits": [
    "Only two of Talk's notices have an equivalent here and cross as such: a conversation being created, and someone being added. The others (moderator promoted, call started, conversation renamed, lobby and password changes) are dropped, and pinning and deletion are already carried by the message itself.",
    "Nextcloud's own conversations (changelog, note to self, former one-to-one, and the sample conversations Talk installs for each account) are left behind.",
    "Accounts with no address in Nextcloud cannot be matched automatically: they need a manual pass at import time.",
    "A file is imported with its owner and its path, not attached to the message that shared it: Talk records a share, not an attachment.",
    "Contacts are not exported and never will be: an address book is outside what Ruchoir does.",
    "Calendars and events are not exported yet: they wait for the calendar feature.",
    "File shares between accounts and groups are not exported: every file arrives owned by the account that held it, and who else could reach it is not carried over.",
    "Nextcloud groups are not exported: group membership does not become anything in the imported space.",
    "File versions, the trash, tags and favourites are not exported: only the current content of each file crosses.",
    "Call recordings, polls and reminders are not exported.",
    "Message edits are not exported: Nextcloud keeps only the current text.",
    "No conversation is marked archived: in Talk, archiving is a per-participant setting, not a property of the conversation, so the source holds no such fact.",
    "Profile pictures are not exported: Nextcloud generates them from initials unless the account uploaded one.",
    "Deleted messages are not exported: Talk keeps a tombstone, not the text.",
    "Nobody arrives with saved messages: Talk has no such thing to export.",
    "A reading position can name a message that did not cross (a system message, or one in a conversation left behind): the import moves it back to the nearest message it does have.",
    "Messages written by guests or bots are exported with an author of the form guests:<id>, which matches no account: they are imported as coming from an absent author."
  ]
}
JSON

echo
echo "  $(count "${OUT}/users.jsonl") accounts, $(count "${OUT}/channels.jsonl") conversations, $(count "${OUT}/messages.jsonl") messages, ${FILE_COUNT} files"
echo "  read ${OUT}/manifest.json for what was deliberately left behind"

# --- Sealing ---------------------------------------------------------------------------------
# An export is a complete copy of a company's conversations. It gets sealed before it goes
# anywhere: OpenPGP symmetric encryption, because gpg is already on the machine that runs a
# Nextcloud and an administrator needs no key management to use it.
#
# The archive is tarred without compression: gpg does the compressing, and doing it twice on 60 GB
# of photographs and PDFs only costs time.
if [ "${ENCRYPT}" -eq 0 ]; then
  echo
  echo "NOT ENCRYPTED (--no-encrypt): ${OUT}"
  echo "  do not move this off the machine as it is."
  exit 0
fi

ARCHIVE="${OUT%/}.tar.gpg"
GENERATED=0
if [ -z "${PASSPHRASE_FILE}" ]; then
  # Generated rather than asked for: a passphrase an administrator invents under time pressure is
  # the weakest part of the chain, and this one is typed exactly twice.
  PASSPHRASE_FILE="$(mktemp)"
  chmod 600 "${PASSPHRASE_FILE}"
  GENERATED=1
  # `head -c` first, never last: closing the pipe early kills the producer with SIGPIPE, and
  # `set -o pipefail` turns that into a silent exit right before the archive gets sealed.
  head -c 256 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9' | cut -c1-40 > "${PASSPHRASE_FILE}"
fi

echo
echo "sealing"
tar -C "$(dirname "${OUT}")" -cf - "$(basename "${OUT}")" \
  | gpg --batch --yes --quiet \
        --symmetric --cipher-algo AES256 --digest-algo SHA512 \
        --s2k-mode 3 --s2k-count 65011712 \
        --passphrase-file "${PASSPHRASE_FILE}" \
        --output "${ARCHIVE}"

# The clear copy does not survive the sealing.
rm -rf "${OUT}"

echo
echo "done: ${ARCHIVE}"
echo "       $(du -h "${ARCHIVE}" | cut -f1)"
if [ "${GENERATED}" -eq 1 ]; then
  echo
  echo "  Passphrase (write it down now, it is not stored anywhere):"
  echo
  echo "      $(cat "${PASSPHRASE_FILE}")"
  echo
  echo "  The import screen asks for it. Without it the archive cannot be opened, by us or by"
  echo "  anyone else. Send it to the person doing the import through a different channel than"
  echo "  the archive itself."
  shred -u "${PASSPHRASE_FILE}" 2>/dev/null || rm -f "${PASSPHRASE_FILE}"
fi
