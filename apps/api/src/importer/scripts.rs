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

/// The Teams reader, embedded verbatim from `packages/importer`.
pub const CONVERT_TEAMS_PY: &str = include_str!("../../../../packages/importer/convert-teams.py");

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
      echo "Converter options after --: --space-name <name>, --no-files, --with-private,"
      echo "--token-file <path>."
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

/// Teams: there is no export to hand over, so the reader talks to Microsoft Graph itself, with an
/// application the organisation registered for the migration. A large tenant is hours of reading,
/// so the reader keeps what it has read in a cache that outlives this script: a run that stops
/// resumes when the same command is given again. The cache holds the conversations in clear, so it
/// is its owner's alone and it is removed once the archive has been delivered.
pub const IMPORT_TEAMS_SH: &str = r#"#!/usr/bin/env bash
# Read a Microsoft Teams organisation and deliver it to Ruchoir in one command. Runs on any machine
# with python3, gpg and curl (the Ruchoir host is the usual one), against Microsoft Graph, with an
# application the organisation registered for the migration (--help-app says how).
set -euo pipefail
BASE="__RUCHOIR_BASE__"
TOKEN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --token) TOKEN="${2:-}"; shift 2 ;;
    --) shift; break ;;
    -h|--help)
      echo "Usage: curl -fsSL $BASE/tools/import-teams.sh | bash -s -- \\"
      echo "         --token <token> -- --tenant <tenant id> --client-id <application id> --secret-file <file>"
      echo
      echo "Reader options after --: --team <name> (repeatable), --no-libraries, --no-files, --fresh,"
      echo "--list (the teams the application can read), --help-app (how to register the application)."
      exit 0 ;;
    *) echo "unexpected argument before --: $1 (put reader options after --)" >&2; exit 2 ;;
  esac
done
command -v curl >/dev/null || { echo "this needs curl" >&2; exit 1; }
command -v python3 >/dev/null || { echo "this needs python3" >&2; exit 1; }
umask 077
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
echo "-> fetching the Teams reader from $BASE"
curl -fsSL "$BASE/tools/convert-teams.py" -o "$WORK/convert-teams.py"

# Listing the teams, or reading how to register the application, delivers nothing.
TENANT=""
PREVIOUS=""
for arg in "$@"; do
  case "$arg" in
    --list|--help-app|-h|--help) python3 "$WORK/convert-teams.py" "$@"; exit 0 ;;
  esac
  if [ "$PREVIOUS" = "--tenant" ]; then TENANT="$arg"; fi
  PREVIOUS="$arg"
done
[ -n "$TOKEN" ] || { echo "missing --token: generate one in the import screen" >&2; exit 2; }
command -v gpg >/dev/null || { echo "this needs gpg to seal the archive" >&2; exit 1; }
[ -n "$TENANT" ] || { echo "missing --tenant after --: the Directory (tenant) ID, see --help-app" >&2; exit 2; }

# One cache per organisation, kept between runs so an interrupted read resumes where it stopped.
KEY="$(python3 -c 'import hashlib, sys; print(hashlib.sha256(sys.argv[1].encode()).hexdigest()[:12])' "$TENANT")"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/ruchoir-teams-$KEY"
mkdir -p "$CACHE"
echo "-> reading Teams (the long part: stop it and give the same command again to resume)"
set +e
python3 "$WORK/convert-teams.py" --out "$WORK/archive" --cache "$CACHE" "$@"
STATUS=$?
set -e
if [ "$STATUS" -ne 0 ]; then
  echo >&2
  echo "What was read so far is kept in $CACHE, and the same command picks up from there." >&2
  echo "If you give up instead, delete that directory: it holds the conversations in clear." >&2
  exit "$STATUS"
fi
echo "-> sealing"
PF="$(mktemp)"; chmod 600 "$PF"
head -c 256 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9' | cut -c1-40 > "$PF"
tar -C "$WORK" -cf - archive | gpg --batch --yes --quiet --symmetric \
  --cipher-algo AES256 --digest-algo SHA512 --s2k-mode 3 --s2k-count 65011712 \
  --passphrase-file "$PF" --output "$WORK/archive.tar.gpg"
echo "-> delivering the sealed archive to $BASE"
curl -fsSL --retry 3 -H "X-Drop-Token: $TOKEN" --upload-file "$WORK/archive.tar.gpg" "$BASE/api/v1/imports/drop"
# Delivered: what was read is in the sealed archive now, and nowhere else in clear.
rm -rf "$CACHE"
echo
echo "  Passphrase (write it down now, it is stored nowhere):"
echo
echo "      $(cat "$PF")"
echo
echo "OK - delivered. Enter this passphrase in the import screen; the archive is now listed there."
echo "Then delete the client secret file, and the application registration in Entra ID."
shred -u "$PF" 2>/dev/null || rm -f "$PF"
"#;

#[cfg(test)]
mod tests {
    use super::*;

    /// Every delivery script is one bash accepts, once the instance's address is stamped in. They
    /// are strings inside Rust, where no editor and no linter ever reads them as shell, and the
    /// first to notice a missing `fi` would otherwise be an administrator in the middle of a
    /// migration.
    #[test]
    fn every_delivery_script_parses_as_bash() {
        for (name, template) in [
            ("import-nextcloud.sh", IMPORT_NEXTCLOUD_SH),
            ("import-mattermost.sh", IMPORT_MATTERMOST_SH),
            ("import-slack.sh", IMPORT_SLACK_SH),
            ("import-teams.sh", IMPORT_TEAMS_SH),
        ] {
            let script = render(template, "https://ruchoir.example/");
            assert!(
                !script.contains(BASE_PLACEHOLDER),
                "{name} still carries the placeholder"
            );
            assert!(
                script.contains("BASE=\"https://ruchoir.example\""),
                "{name}"
            );
            let parsed = std::process::Command::new("bash")
                .args(["-n", "-c", &script])
                .output()
                .expect("bash is there to parse with");
            assert!(
                parsed.status.success(),
                "{name} is not valid bash: {}",
                String::from_utf8_lossy(&parsed.stderr)
            );
        }
    }
}
