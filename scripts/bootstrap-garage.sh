#!/bin/sh
# Prepare the object store so file bytes can be written.
#
# A fresh Garage node stores nothing until it has a cluster layout, a key it recognises, a bucket,
# and a grant tying the two together. Until then every upload answers 503 (or 502 once credentials
# are set but the bucket is missing), which is a confusing way to learn that a one-time setup was
# skipped. This does that setup in one command, and is safe to re-run: each step checks the state it
# wants before touching anything.
#
# It runs on the host rather than as a container in the stack because the Garage image ships no
# shell, so the sequence cannot execute inside it. `docker compose exec` is how the CLI is reached.
#
# Usage, from anywhere in the repository:
#   scripts/bootstrap-garage.sh
#
# Reads S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY and S3_BUCKET from .env, which is also where the API
# reads them, so the key Garage is told about is by construction the key the API will present.

set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_root"

if [ ! -f .env ]; then
  echo "no .env found: copy .env.example to .env and fill it in first" >&2
  exit 1
fi

# Sourced in this script's own environment, which dies with it: nothing leaks into the caller's
# shell, where a stale exported value would silently outrank .env on the next `cargo run`.
set -a
# shellcheck disable=SC1091
. ./.env
set +a

: "${S3_ACCESS_KEY_ID:?set S3_ACCESS_KEY_ID in .env}"
: "${S3_SECRET_ACCESS_KEY:?set S3_SECRET_ACCESS_KEY in .env}"
S3_BUCKET=${S3_BUCKET:-ruchoir}

garage() {
  docker compose exec -T garage /garage "$@"
}

echo "Waiting for Garage to answer…"
attempt=0
until garage status >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "Garage is not answering. Is the stack up? Try: docker compose up -d garage" >&2
    exit 1
  fi
  sleep 1
done

# 1. Cluster layout. A single-node deployment still needs one, and the node id is only known at
#    runtime. `layout assign` stages a change and `layout apply` commits it at the next version, so
#    both are skipped once the node already carries a role.
if garage status | grep -q "NO ROLE ASSIGNED"; then
  node_id=$(garage status | awk 'NR==3 {print $1}')
  if [ -z "$node_id" ]; then
    echo "could not read the Garage node id from 'garage status'" >&2
    exit 1
  fi
  echo "Assigning a single-node layout to ${node_id}…"
  garage layout assign -z dc1 -c 1G "$node_id"
  # The version to apply is the current one plus the staged change; Garage reports it, so read it
  # back rather than assuming 1, which only holds on a truly untouched cluster.
  next_version=$(garage layout show | awk '/Current cluster layout version/ {print $5 + 1}')
  garage layout apply --version "${next_version:-1}"
else
  echo "Cluster layout already applied."
fi

# 2. The key pair. Adopted from .env rather than minted here, so the API and Garage cannot disagree
#    about which credentials are valid.
if garage key info "$S3_ACCESS_KEY_ID" >/dev/null 2>&1; then
  echo "Key ${S3_ACCESS_KEY_ID} already known to Garage."
else
  echo "Importing the key pair from .env…"
  garage key import --yes "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY"
fi

# 3. The bucket.
if garage bucket info "$S3_BUCKET" >/dev/null 2>&1; then
  echo "Bucket ${S3_BUCKET} already exists."
else
  echo "Creating bucket ${S3_BUCKET}…"
  garage bucket create "$S3_BUCKET"
fi

# 4. The grant. Re-granting is harmless in Garage, but it answers with the whole bucket description,
#    which would make the one step that always runs also the loudest. Checked like the others so a
#    re-run stays quiet and only reports what it skipped.
if garage bucket info "$S3_BUCKET" 2>/dev/null | grep -q "RWO.*${S3_ACCESS_KEY_ID}"; then
  echo "Key already has read/write/owner on ${S3_BUCKET}."
else
  echo "Granting the key read/write/owner on ${S3_BUCKET}…"
  garage bucket allow --read --write --owner "$S3_BUCKET" --key "$S3_ACCESS_KEY_ID" >/dev/null
fi

echo
echo "Object storage is ready. Restart the API if it was already running:"
echo "  cargo run -p ruchoir-api"
