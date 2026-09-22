#!/usr/bin/env bash
# The whole rehearsal, from empty servers to two sealed archives.
#
#     packages/importer/e2e/run.sh
#
# What it proves is the one thing the unit tests cannot: that an export taken from a real server,
# by the commands the import screen tells a customer to run, produces an archive this product
# accepts. Every defect it has caught so far was invisible from a generated archive - a shell that
# executed words out of a SQL comment, a data directory belonging to a deleted account, a direct
# conversation written the other way round.
#
# It needs docker, sudo (the Nextcloud data directory belongs to www-data, as it does in
# production), gpg and python3. It leaves the two archives in $E2E_DIR and the servers running,
# so the import can then be driven by hand; `run.sh down` puts everything away.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMPORTER="$(dirname "$HERE")"
export E2E_DIR="${E2E_DIR:-/tmp/ruchoir-e2e}"
COMPOSE="docker compose -f $HERE/docker-compose.yml"

if [ "${1:-up}" = "down" ]; then
  $COMPOSE down -v
  sudo -n rm -rf "$E2E_DIR"
  echo "servers and archives removed"
  exit 0
fi

mkdir -p "$E2E_DIR"
$COMPOSE up -d

echo "waiting for Nextcloud"
until curl -sf -o /dev/null http://127.0.0.1:8081/status.php; do sleep 5; done
echo "waiting for Mattermost"
until curl -sf -o /dev/null http://127.0.0.1:8065/api/v4/system/ping; do sleep 5; done

"$HERE/seed-nextcloud.sh"
python3 "$HERE/seed-mattermost.py"

# --- Nextcloud: the script the customer runs on their own server ---------------------------------
echo "exporting Nextcloud"
rm -rf "$E2E_DIR/nc-out" "$E2E_DIR/nc-out.tar.gpg"
printf 'atelier-nextcloud' > "$E2E_DIR/nc-pass.txt"
sudo -n env NC_DB_HOST=127.0.0.1 NC_DB_NAME=nextcloud NC_DB_USER=nextcloud NC_DB_PASS=ncpass \
  "$IMPORTER/export-nextcloud.sh" \
  --data-dir "$E2E_DIR/nc-data" --out "$E2E_DIR/nc-out" \
  --space-name "Atelier Nextcloud" --docker-db e2e-ncdb \
  --passphrase-file "$E2E_DIR/nc-pass.txt" >/dev/null
sudo -n chown "$(id -u):$(id -g)" "$E2E_DIR/nc-out.tar.gpg"

# --- Mattermost: mmctl, then our adapter ----------------------------------------------------------
echo "exporting Mattermost"
JOB=$(docker exec e2e-mattermost mmctl --local export create | sed 's/.*ID: //')
until docker exec e2e-mattermost mmctl --local export list 2>/dev/null | grep -q "${JOB}_export.zip"; do sleep 5; done
docker exec e2e-mattermost mmctl --local export download "${JOB}_export.zip" /tmp/export.zip >/dev/null
docker cp e2e-mattermost:/tmp/export.zip "$E2E_DIR/mm-export.zip" >/dev/null
rm -rf "$E2E_DIR/mm-export" "$E2E_DIR/mm-out"
mkdir -p "$E2E_DIR/mm-export"
unzip -q "$E2E_DIR/mm-export.zip" -d "$E2E_DIR/mm-export"
python3 "$IMPORTER/convert-mattermost.py" --export "$E2E_DIR/mm-export" --out "$E2E_DIR/mm-out" >/dev/null
printf 'atelier-mattermost' > "$E2E_DIR/mm-pass.txt"
# Sealed with the command docs/import-archive.md gives, so the rehearsal covers that too.
tar -C "$E2E_DIR/mm-out" -cf - . | gpg --batch --yes --symmetric \
  --cipher-algo AES256 --digest-algo SHA512 --s2k-mode 3 --s2k-count 65011712 \
  --passphrase-file "$E2E_DIR/mm-pass.txt" --output "$E2E_DIR/mm-out.tar.gpg"

python3 "$IMPORTER/validate-archive.py" "$E2E_DIR/mm-out"

cat <<INFO

two archives, from two real servers:

  $E2E_DIR/nc-out.tar.gpg   passphrase: $(cat "$E2E_DIR/nc-pass.txt")
  $E2E_DIR/mm-out.tar.gpg   passphrase: $(cat "$E2E_DIR/mm-pass.txt")

drop them in the import directory of a Ruchoir instance and import them from the screen. The
servers stay up (Nextcloud on 8081, Mattermost on 8065); run.sh down puts everything away.
INFO
