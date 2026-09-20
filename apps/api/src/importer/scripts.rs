//! Scripts the instance serves at `/tools`, so an administrator runs one command instead of
//! cloning a repository and learning its flags.
//!
//! Two kinds live here. The **producers** (`export-nextcloud.sh`, `convert-mattermost.py`) are the
//! real tools, shipped in `packages/importer` and embedded unchanged: serving them from the
//! instance means the one-liner has somewhere to fetch them from that is the administrator's own
//! domain, not ours. The **orchestrators** (`import-*.sh`) are what the import screen actually
//! shows: each fetches its producer, runs it, seals the result if the producer did not, and
//! delivers the sealed archive back to this instance with a one-time drop token.
//!
//! The instance's own base URL is stamped in at request time. Nothing here holds a secret - the
//! drop token is the administrator's, passed to the command as an argument.

/// The Nextcloud producer, embedded verbatim from `packages/importer`.
pub const EXPORT_NEXTCLOUD_SH: &str =
    include_str!("../../../../packages/importer/export-nextcloud.sh");

/// The Mattermost converter, embedded verbatim from `packages/importer`.
pub const CONVERT_MATTERMOST_PY: &str =
    include_str!("../../../../packages/importer/convert-mattermost.py");

/// The Slack converter, embedded verbatim from `packages/importer`.
pub const CONVERT_SLACK_PY: &str = include_str!("../../../../packages/importer/convert-slack.py");

const BASE_PLACEHOLDER: &str = "__RUCHOIR_BASE__";

/// Stamp the instance's base URL into an orchestrator before serving it.
pub fn render(template: &str, base_url: &str) -> String {
    template.replace(BASE_PLACEHOLDER, base_url.trim_end_matches('/'))
}

/// Nextcloud: the producer seals the archive itself and prints the passphrase, so the orchestrator
/// only fetches it, runs it, and delivers the `.tar.gpg` it leaves behind.
pub const IMPORT_NEXTCLOUD_SH: &str = r#"#!/usr/bin/env bash
# Export a Nextcloud and deliver it to Ruchoir in one command. Runs on the Nextcloud host, reads
# only, and uploads the sealed archive to the instance that served this script.
set -euo pipefail
BASE="__RUCHOIR_BASE__"
TOKEN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --token) TOKEN="${2:-}"; shift 2 ;;
    --) shift; break ;;
    -h|--help)
      echo "Usage: curl -fsSL $BASE/tools/import-nextcloud.sh | bash -s -- \\"
      echo "         --token <token> -- --config /var/www/html/config/config.php --data-dir /var/www/html/data"
      exit 0 ;;
    *) echo "unexpected argument before --: $1 (put exporter options after --)" >&2; exit 2 ;;
  esac
done
[ -n "$TOKEN" ] || { echo "missing --token: generate one in the import screen" >&2; exit 2; }
command -v curl >/dev/null || { echo "this needs curl" >&2; exit 1; }
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
echo "-> fetching the Nextcloud exporter from $BASE"
curl -fsSL "$BASE/tools/export-nextcloud.sh" -o "$WORK/export-nextcloud.sh"
OUT="$WORK/ruchoir-export"
echo "-> exporting (nothing is written to Nextcloud)"
bash "$WORK/export-nextcloud.sh" --out "$OUT" "$@"
echo "-> delivering the sealed archive to $BASE"
curl -fsSL --retry 3 -H "X-Drop-Token: $TOKEN" --upload-file "$OUT.tar.gpg" "$BASE/api/v1/imports/drop"
echo
echo "OK - delivered. Back in the import screen the archive is now listed; enter the passphrase printed above."
"#;

/// Mattermost: the converter writes an unsealed archive directory, so the orchestrator seals it
/// (the same OpenPGP command the contract specifies) before delivering, and prints the passphrase.
pub const IMPORT_MATTERMOST_SH: &str = r#"#!/usr/bin/env bash
# Convert a Mattermost bulk export and deliver it to Ruchoir in one command. Runs on the Ruchoir
# host, on an export the customer handed over (mmctl export create).
set -euo pipefail
BASE="__RUCHOIR_BASE__"
TOKEN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --token) TOKEN="${2:-}"; shift 2 ;;
    --) shift; break ;;
    -h|--help)
      echo "Usage: curl -fsSL $BASE/tools/import-mattermost.sh | bash -s -- \\"
      echo "         --token <token> -- --export <unpacked export dir>"
      exit 0 ;;
    *) echo "unexpected argument before --: $1 (put converter options after --)" >&2; exit 2 ;;
  esac
done
[ -n "$TOKEN" ] || { echo "missing --token: generate one in the import screen" >&2; exit 2; }
command -v curl >/dev/null || { echo "this needs curl" >&2; exit 1; }
command -v gpg >/dev/null || { echo "this needs gpg to seal the archive" >&2; exit 1; }
command -v python3 >/dev/null || { echo "this needs python3" >&2; exit 1; }
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
echo "-> fetching the Mattermost converter from $BASE"
curl -fsSL "$BASE/tools/convert-mattermost.py" -o "$WORK/convert-mattermost.py"
echo "-> converting"
python3 "$WORK/convert-mattermost.py" --out "$WORK/archive" "$@"
echo "-> sealing"
PF="$(mktemp)"; chmod 600 "$PF"
head -c 256 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9' | cut -c1-40 > "$PF"
tar -C "$WORK" -cf - archive | gpg --batch --yes --quiet --symmetric \
  --cipher-algo AES256 --digest-algo SHA512 --s2k-mode 3 --s2k-count 65011712 \
  --passphrase-file "$PF" --output "$WORK/archive.tar.gpg"
echo "-> delivering the sealed archive to $BASE"
curl -fsSL --retry 3 -H "X-Drop-Token: $TOKEN" --upload-file "$WORK/archive.tar.gpg" "$BASE/api/v1/imports/drop"
echo
echo "  Passphrase (write it down now, it is stored nowhere):"
echo
echo "      $(cat "$PF")"
echo
echo "OK - delivered. Enter this passphrase in the import screen; the archive is now listed there."
shred -u "$PF" 2>/dev/null || rm -f "$PF"
"#;

/// Slack: the converter downloads the attachments, because a Slack export carries links to its
/// files rather than the files. The export signs its own links, so the ordinary run asks for
/// nothing; when they have expired the converter stops and prints how to make a token, and this
/// script passes that exit code through rather than sealing an archive with no files in it.
pub const IMPORT_SLACK_SH: &str = r#"#!/usr/bin/env bash
# Convert a Slack workspace export and deliver it to Ruchoir in one command. Runs on the Ruchoir
# host, on the ZIP an owner downloaded from Slack (Settings -> Import/Export Data -> Export).
set -euo pipefail
BASE="__RUCHOIR_BASE__"
TOKEN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --token) TOKEN="${2:-}"; shift 2 ;;
    --) shift; break ;;
    -h|--help)
      echo "Usage: curl -fsSL $BASE/tools/import-slack.sh | bash -s -- \\"
      echo "         --token <token> -- --export <unpacked Slack export dir>"
      echo
      echo "Converter options after --: --space-name <name>, --no-files, --token-file <path>."
      exit 0 ;;
    *) echo "unexpected argument before --: $1 (put converter options after --)" >&2; exit 2 ;;
  esac
done
[ -n "$TOKEN" ] || { echo "missing --token: generate one in the import screen" >&2; exit 2; }
command -v curl >/dev/null || { echo "this needs curl" >&2; exit 1; }
command -v gpg >/dev/null || { echo "this needs gpg to seal the archive" >&2; exit 1; }
command -v python3 >/dev/null || { echo "this needs python3" >&2; exit 1; }
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
echo "-> fetching the Slack converter from $BASE"
curl -fsSL "$BASE/tools/convert-slack.py" -o "$WORK/convert-slack.py"
echo "-> converting (the attachments are downloaded from Slack, this is the slow part)"
# Exit code 3 means the export's own file links have expired; the converter has just printed how
# to carry on, so this stops here rather than sealing an archive missing its files.
set +e
python3 "$WORK/convert-slack.py" --out "$WORK/archive" "$@"
STATUS=$?
set -e
[ "$STATUS" -eq 0 ] || exit "$STATUS"
echo "-> sealing"
PF="$(mktemp)"; chmod 600 "$PF"
head -c 256 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9' | cut -c1-40 > "$PF"
tar -C "$WORK" -cf - archive | gpg --batch --yes --quiet --symmetric \
  --cipher-algo AES256 --digest-algo SHA512 --s2k-mode 3 --s2k-count 65011712 \
  --passphrase-file "$PF" --output "$WORK/archive.tar.gpg"
echo "-> delivering the sealed archive to $BASE"
curl -fsSL --retry 3 -H "X-Drop-Token: $TOKEN" --upload-file "$WORK/archive.tar.gpg" "$BASE/api/v1/imports/drop"
echo
echo "  Passphrase (write it down now, it is stored nowhere):"
echo
echo "      $(cat "$PF")"
echo
echo "OK - delivered. Enter this passphrase in the import screen; the archive is now listed there."
shred -u "$PF" 2>/dev/null || rm -f "$PF"
"#;
