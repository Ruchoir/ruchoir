"""Puts a small workspace into the running Mattermost: a team, accounts, channels, a thread, a
pinned post, a reaction, an edit, an attachment and a direct conversation.

Through the REST API a person would use, never straight into the database: what the bulk export
writes is decided by the server, and that is exactly what is being rehearsed here.
"""

import json, urllib.request, urllib.error


BASE = "http://127.0.0.1:8065/api/v4"
TOKEN = None

def call(path, data=None, method=None, token=None, raw=None, headers=None):
    url = BASE + path
    body = None
    h = {"Content-Type": "application/json"}
    if headers: h.update(headers)
    if data is not None: body = json.dumps(data).encode()
    if raw is not None: body = raw
    req = urllib.request.Request(url, data=body, method=method or ("POST" if body else "GET"))
    for k, v in h.items(): req.add_header(k, v)
    if token: req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read() or b"{}"), r.headers
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{path}: {e.code} {e.read()[:300]}")

# 1. le premier compte devient administrateur système
admin = {"email": "admin@atelier.test", "username": "admin", "password": "AdminAtelier2026!"}
# The first account of a fresh server becomes its system administrator.
try:
    call("/users", admin)
except SystemExit as e:
    print("admin already there:", e)
_, headers = call("/users/login", {"login_id": "admin", "password": admin["password"]})
TOKEN = headers["Token"]
print("connecté")

team, _ = call("/teams", {"name": "atelier", "display_name": "Atelier", "type": "O"}, token=TOKEN)
print("équipe", team["id"])

people = {}
for name, first, last, email in [
    ("camille", "Camille", "Vilain", "camille@atelier.test"),
    ("yanis", "Yanis", "Berthier", "yanis@atelier.test"),
    ("awa", "Awa", "Diallo", "awa@atelier.test"),
]:
    u, _ = call("/users", {"email": email, "username": name, "password": "UserAtelier2026!",
                           "first_name": first, "last_name": last}, token=TOKEN)
    people[name] = u["id"]
    call(f"/teams/{team['id']}/members", {"team_id": team["id"], "user_id": u["id"]}, token=TOKEN)
admin_id = call("/users/username/admin", token=TOKEN)[0]["id"]
call(f"/teams/{team['id']}/members", {"team_id": team["id"], "user_id": admin_id}, token=TOKEN)
print("comptes", list(people))

chans = {}
for name, disp, kind in [("general2", "Général", "O"), ("produit", "Produit", "O"), ("direction", "Direction", "P")]:
    c, _ = call("/channels", {"team_id": team["id"], "name": name, "display_name": disp, "type": kind}, token=TOKEN)
    chans[name] = c["id"]
    for uid in list(people.values()) + [admin_id]:
        call(f"/channels/{c['id']}/members", {"user_id": uid}, token=TOKEN)
print("canaux", list(chans))

def as_user(name):
    _, h = call("/users/login", {"login_id": name, "password": "UserAtelier2026!"})
    return h["Token"]

tokens = {n: as_user(n) for n in people}

root, _ = call("/posts", {"channel_id": chans["general2"], "message": "Bonjour à toutes et à tous : on ouvre l'atelier ici."}, token=tokens["camille"])
call("/posts", {"channel_id": chans["general2"], "message": "Bien reçu, je bascule mes notes ce soir.", "root_id": root["id"]}, token=tokens["yanis"])
call("/posts", {"channel_id": chans["general2"], "message": "Présente ! J'apporte les maquettes.", "root_id": root["id"]}, token=tokens["awa"])
call("/posts", {"channel_id": chans["produit"], "message": "La refonte démarre lundi, relecture d'ici jeudi."}, token=tokens["camille"])
p5, _ = call("/posts", {"channel_id": chans["direction"], "message": "Point budget reporté à lundi."}, token=tokens["camille"])
call(f"/posts/{root['id']}/pin", {}, method="POST", token=tokens["camille"])
call("/reactions", {"user_id": people["yanis"], "post_id": root["id"], "emoji_name": "+1"}, token=tokens["yanis"])

# un message modifié
edited, _ = call("/posts", {"channel_id": chans["produit"], "message": "Maquette v2 déposée."}, token=tokens["awa"])
call(f"/posts/{edited['id']}", {"id": edited["id"], "message": "Maquette v3 déposée."}, method="PUT", token=tokens["awa"])

# une pièce jointe
boundary = "----mmseed"
content = b"maquette v3\nrefonte 2026\n"
body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"channel_id\"\r\n\r\n{chans['produit']}\r\n"
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"files\"; filename=\"maquette.txt\"\r\n"
        f"Content-Type: text/plain\r\n\r\n").encode() + content + f"\r\n--{boundary}--\r\n".encode()
up, _ = call("/files", raw=body, token=tokens["awa"], headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
fid = up["file_infos"][0]["id"]
call("/posts", {"channel_id": chans["produit"], "message": "Voici le fichier.", "file_ids": [fid]}, token=tokens["awa"])

# un message direct
dm, _ = call("/channels/direct", [people["camille"], people["yanis"]], token=tokens["camille"])
call("/posts", {"channel_id": dm["id"], "message": "Tu as deux minutes ?"}, token=tokens["camille"])
call("/posts", {"channel_id": dm["id"], "message": "Oui, j'arrive."}, token=tokens["yanis"])
print("contenu écrit")
