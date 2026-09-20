#!/usr/bin/env bash
# Puts a small workspace into the running Nextcloud: accounts, Talk conversations, messages, a
# reaction, a favourite, a reading position, files, and somebody who left.
#
# Everything goes through the APIs a person would use, never straight into the database: the point
# is to read back what Nextcloud itself wrote, including the rows nobody thought to mention.
set -euo pipefail

NC=${NC_URL:-http://127.0.0.1:8081}
P='UserAtelier2026!'
api() { local auth="$1" method="$2" path="$3"; shift 3
  curl -s -u "$auth" -X "$method" -H 'OCS-APIRequest: true' -H 'Accept: application/json' "$@" "$NC$path"; }
token() { python3 -c 'import json,sys; print(json.load(sys.stdin)["ocs"]["data"]["token"])'; }
msgid() { python3 -c 'import json,sys; print(json.load(sys.stdin)["ocs"]["data"]["id"])'; }
occ() { docker exec -u www-data e2e-nextcloud php occ "$@"; }

occ app:install spreed >/dev/null 2>&1 || occ app:enable spreed >/dev/null

for u in camille yanis awa noe; do
  OC_PASS="$P" docker exec -u www-data -e OC_PASS="$P" e2e-nextcloud \
    php occ user:add --password-from-env --display-name "${u^} Dupont" "$u" >/dev/null
done
# Three addresses and one without: an export with nobody missing is not the common case.
occ user:setting camille settings email "camille@atelier.test" >/dev/null
occ user:setting yanis settings email "yanis@atelier.test" >/dev/null
occ user:setting awa settings email "awa@atelier.test" >/dev/null

GEN=$(api "camille:$P" POST /ocs/v2.php/apps/spreed/api/v4/room -d roomType=2 -d roomName="Général" | token)
PRO=$(api "camille:$P" POST /ocs/v2.php/apps/spreed/api/v4/room -d roomType=3 -d roomName="Produit" | token)
for room in "$GEN" "$PRO"; do
  for who in yanis awa noe; do
    api "camille:$P" POST "/ocs/v2.php/apps/spreed/api/v4/room/$room/participants" \
      -d newParticipant="$who" -d source=users >/dev/null
  done
done
DM=$(api "camille:$P" POST /ocs/v2.php/apps/spreed/api/v4/room -d roomType=1 -d invite=yanis | token)

say() { api "$1:$P" POST "/ocs/v2.php/apps/spreed/api/v1/chat/$2" -d message="$3" | msgid; }
FIRST=$(say camille "$GEN" "Bonjour à toutes et à tous : on ouvre l'atelier ici.")
SECOND=$(say yanis "$GEN" "Bien reçu, je bascule mes notes ce soir.")
say awa "$GEN" "Présente ! J'apporte les maquettes." >/dev/null
say camille "$PRO" "La refonte démarre lundi, relecture d'ici jeudi." >/dev/null
say awa "$PRO" "Maquette v3 déposée dans mes fichiers." >/dev/null
say noe "$GEN" "Je passe la main avant de partir vendredi." >/dev/null
say camille "$DM" "Tu as deux minutes ?" >/dev/null
say yanis "$DM" "Oui, j'arrive." >/dev/null

api "yanis:$P" POST "/ocs/v2.php/apps/spreed/api/v1/reaction/$GEN/$FIRST" -d reaction="👍" >/dev/null
api "yanis:$P" POST "/ocs/v2.php/apps/spreed/api/v4/room/$GEN/favorite" >/dev/null
api "yanis:$P" POST "/ocs/v2.php/apps/spreed/api/v1/chat/$GEN/read" -d lastReadMessage="$SECOND" >/dev/null

printf 'Maquette v3 - refonte 2026\n' > /tmp/e2e-maquette.md
printf 'Compte rendu du 12 mars\n' > /tmp/e2e-cr.txt
curl -s -u "awa:$P" -T /tmp/e2e-maquette.md "$NC/remote.php/dav/files/awa/maquette.md" -o /dev/null
curl -s -u "camille:$P" -T /tmp/e2e-cr.txt "$NC/remote.php/dav/files/camille/cr.txt" -o /dev/null
rm -f /tmp/e2e-maquette.md /tmp/e2e-cr.txt

# Noé leaves the company. Nextcloud keeps his messages and his data directory; the export has to
# carry both, and the import has to place them without an account to hang them on.
occ user:disable noe >/dev/null

echo "seeded: general=$GEN produit=$PRO direct=$DM"
