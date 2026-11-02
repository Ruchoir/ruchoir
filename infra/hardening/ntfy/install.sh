#!/usr/bin/env bash
#
# Install ntfy (the push service for alerts) on the site server: its Compose project in
# /opt/ruchoir-ntfy, the nginx vhost, and the accounts. Run through `infra/hardening/install ntfy`,
# as root. Idempotent: a second run prints only "unchanged" lines and creates nothing twice.
#
# Two steps need a person, because they cannot be repeated blindly:
#   1. The certificate. The vhost is first installed on port 80 only; the script prints the certbot
#      command (Actalis, with the account flags of the existing certificates) and stops. Run it,
#      then run this install again: the full vhost goes in.
#   2. The tokens. They are printed once, at the moment the accounts are created, for the
#      hardening.env of each server (NOTIFY_NTFY_TOKEN) and for the iPhone app (reader password).
#
# Keys read from hardening.env: NTFY_PUBLIC_NAME, NTFY_READER_USER, and optionally NTFY_TOPIC_APP
# and NTFY_TOPIC_SITE (default app-alerts and site-alerts).
# HARDENING_PREFIX and HARDENING_DRY_RUN=1 (no docker, nginx, certbot) serve the tests.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="${HARDENING_ROOT:-$(dirname "$here")}"
# shellcheck source=../common/lib.sh
. "$root/common/lib.sh"

prefix="${HARDENING_PREFIX:-}"
dry="${HARDENING_DRY_RUN:-0}"
role="${RUCHOIR_HARDENING_ROLE:-$(env_get RUCHOIR_HARDENING_ROLE)}"
if [ "$role" != site ]; then
  echo "ntfy is installed on the site server only (RUCHOIR_HARDENING_ROLE=$role)" >&2
  exit 1
fi

name="$(env_get NTFY_PUBLIC_NAME)"
reader="$(env_get NTFY_READER_USER)"
topic_app="$(env_get NTFY_TOPIC_APP 2>/dev/null || echo app-alerts)"
topic_site="$(env_get NTFY_TOPIC_SITE 2>/dev/null || echo site-alerts)"

dir="$prefix/opt/ruchoir-ntfy"
data="$prefix/var/lib/ruchoir-ntfy"
vhost="$prefix/etc/nginx/sites-available/ruchoir-ntfy"
enabled="$prefix/etc/nginx/sites-enabled/ruchoir-ntfy"
cert="$prefix/etc/letsencrypt/live/$name/fullchain.pem"
uid=10096

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

# ---- the Compose project -----------------------------------------------------------------------
install -d -m 0755 "$dir"
install -d -m 0750 "$data"
if [ "$dry" != 1 ]; then
  chown "$uid:$uid" "$data"
fi
install_file "$here/compose.yml" "$dir/compose.yml" 0644
install_file "$here/server.yml" "$dir/server.yml" 0644
printf 'NTFY_BASE_URL=https://%s\n' "$name" >"$scratch/env"
install_file "$scratch/env" "$dir/.env" 0600

# ---- nginx -------------------------------------------------------------------------------------
if [ -e "$cert" ]; then
  sed "s|__NTFY_PUBLIC_NAME__|$name|g" "$here/nginx.conf.template" >"$scratch/vhost"
  need_cert=0
else
  # Port 80 only: certbot's nginx authenticator needs a server block for the name to answer on.
  cat >"$scratch/vhost" <<EOF
# Temporary: replaced by the full vhost once the certificate exists (re-run the ntfy install).
server {
    listen 80;
    listen [::]:80;
    server_name $name;
    location / { return 404; }
}
EOF
  need_cert=1
fi
install_file "$scratch/vhost" "$vhost" 0644
if [ -L "$enabled" ] && [ "$(readlink "$enabled")" = "/etc/nginx/sites-available/ruchoir-ntfy" ]; then
  say "unchanged $enabled"
else
  install -d "$(dirname "$enabled")"
  ln -sfn /etc/nginx/sites-available/ruchoir-ntfy "$enabled"
  say "installed $enabled"
fi

if [ "$dry" = 1 ]; then
  say "dry run: docker, nginx, certbot and the accounts not touched"
  if [ "$need_cert" = 1 ]; then say "certificate for $name still to obtain (see the printed command in a real run)"; fi
  exit 0
fi

nginx -t
systemctl reload nginx

if [ "$need_cert" = 1 ]; then
  cat <<EOF

No certificate for $name yet. Obtain it, with the same Actalis account flags as
the renewal file of an existing certificate under /etc/letsencrypt/renewal/ (the external account binding), then run this install again:

  certbot certonly --nginx \\
    --server https://acme-api.actalis.com/acme/directory \\
    --eab-kid <KID> --eab-hmac-key <HMAC_KEY> \\
    -d $name

EOF
  exit 0
fi

# ---- the container -----------------------------------------------------------------------------
compose() { docker compose -p ruchoir-ntfy --project-directory "$dir" -f "$dir/compose.yml" "$@"; }
compose up -d
for _ in $(seq 1 30); do
  if compose exec -T ntfy wget -q -O - http://localhost:8080/v1/health 2>/dev/null | grep -q '"healthy":true'; then
    healthy=1
    break
  fi
  sleep 2
done
if [ "${healthy:-0}" != 1 ]; then
  echo "ntfy did not become healthy; see: docker logs ruchoir-ntfy-ntfy-1" >&2
  exit 1
fi
say "unchanged ntfy is healthy"

# ---- accounts ----------------------------------------------------------------------------------
ntfy_cli() { compose exec -T ntfy ntfy "$@"; }
have_user() { ntfy_cli user list 2>/dev/null | grep -q "^user $1 "; }
random_secret() { openssl rand -base64 24 | tr -d '/+=\n'; }

# One reader (the phone), read-only on both servers' topics.
if have_user "$reader"; then
  say "unchanged account $reader"
else
  password="$(random_secret)"
  compose exec -T -e NTFY_PASSWORD="$password" ntfy ntfy user add --role=user "$reader"
  ntfy_cli access "$reader" "$topic_app" read-only
  ntfy_cli access "$reader" "$topic_site" read-only
  say "installed account $reader"
  say "  reader password (shown once, for the iPhone app): $password"
fi

# One publish-only account per server, each with a token for its hardening.env.
publisher() { # publisher SERVER_ROLE TOPIC
  local user="alerts-$1" topic="$2" secret out
  if have_user "$user"; then
    say "unchanged account $user"
    return 0
  fi
  secret="$(random_secret)"
  compose exec -T -e NTFY_PASSWORD="$secret" ntfy ntfy user add --role=user "$user"
  ntfy_cli access "$user" "$topic" write-only
  out="$(ntfy_cli token add --label "$1 alerts" "$user")"
  say "installed account $user (write-only on $topic)"
  say "  $out"
  say "  token above, shown once: NOTIFY_NTFY_TOKEN in the hardening.env of the $1 server"
}
publisher app "$topic_app"
publisher site "$topic_site"
