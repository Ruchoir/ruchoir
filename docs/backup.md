# Backup and restore

An instance holds three stores, and a backup that misses one of them is not a backup:

| Store | What is in it | What losing it costs |
|---|---|---|
| PostgreSQL | Everything written: accounts, spaces, channels, messages, file records, invitations | Everything |
| Garage | The bytes of files, avatars and space icons | Every document, while the database still lists them |
| Valkey | Sessions, presence, the real-time fan-out | Everyone is signed out; nothing is destroyed |

`scripts/backup.sh` takes all three into one encrypted archive, and `scripts/restore.sh` puts them
back. Both act on the instance in the directory they are run from.

## Setting it up

Generate a key, **somewhere that is not this machine**:

```bash
openssl rand -base64 48 > /somewhere/else/ruchoir-backup.key
chmod 600 /somewhere/else/ruchoir-backup.key
```

An archive encrypted with a key that burns in the same fire is a compressed copy of the problem, so
the script refuses to run without one rather than quietly writing everything in the clear. Then, in
`.env`:

```dotenv
RUCHOIR_BACKUP_KEY_FILE=/somewhere/else/ruchoir-backup.key
RUCHOIR_BACKUP_DIR=/var/backups/ruchoir
RUCHOIR_BACKUP_KEEP=14
```

`RUCHOIR_BACKUP_KEEP` is how many archives are kept; the oldest beyond it are deleted at the end of
each run. `0` keeps everything, which is a choice about your disk and not about your safety.

## Taking one

```bash
scripts/backup.sh
```

It stops the API, dumps PostgreSQL, Valkey and Garage, starts the API again, then seals the lot with
`openssl enc -aes-256-cbc -pbkdf2` and writes a `.sha256` beside it.

**The pause is the point.** It lasts as long as the dump (seconds on a small instance) and the three
datastores keep running throughout; what it buys is that nothing can be written between the first
dump and the last, so the archive is one restore point rather than three snapshots of three
different moments. `--no-pause` skips it, and the archive records that it was skipped so a restore
can say so.

## Putting one back

```bash
scripts/restore.sh /var/backups/ruchoir/ruchoir-20260912T212751Z.tar.gz.enc
```

It checks the archive against its own checksum, decrypts it, checks each member against the manifest
inside, tells you when it was taken, and then asks you to type `restore` before touching anything.
**It replaces**: the database is restored with `--clean`, and the Garage volumes are emptied before
the archive's contents go back. There is no merge and no undo.

Everyone signed in since the archive was taken is signed out, because the sessions come back as they
were at that moment. That is the honest behaviour: a session that outlives the state it belonged to
is a session pointing at things that no longer exist.

## Running it every night

With systemd, which is what the `deploy/` unit files are for:

```bash
sudo cp deploy/ruchoir-backup.service deploy/ruchoir-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ruchoir-backup.timer
systemctl list-timers ruchoir-backup.timer
```

Edit `WorkingDirectory` in the service file if the instance does not live in `/opt/ruchoir`. With
cron instead, the same thing is one line:

```cron
30 3 * * * cd /opt/ruchoir && ./scripts/backup.sh >> /var/log/ruchoir-backup.log 2>&1
```

## Checking that it works

A backup nobody has restored is a hypothesis. Two habits:

1. **Read the log of the timer**, not just its state: `journalctl -u ruchoir-backup.service -n 30`.
   A run that fails halfway still restarts the API (that is armed before the first dump), so a
   broken backup is silent unless somebody looks.
2. **Replay a restore somewhere else**, at least once, and again whenever the stack's versions move.
   Copy an archive and the key onto a scratch machine, `docker compose up -d postgres valkey garage`,
   run `scripts/restore.sh`, and open the instance. The procedure in this page was written by doing
   exactly that: a channel was deleted and a space renamed on purpose, and the restore brought both
   back.

## What this does not cover

- **Off-site copies.** The archives land wherever `RUCHOIR_BACKUP_DIR` points, and a single disk is a
  single point of failure. Copy them somewhere else (another machine, a European object store) and
  keep the key somewhere else again.
- **Point-in-time recovery.** You can go back to an archive, not to an arbitrary minute. That needs
  WAL archiving, and it is not set up here.
- **The `.env` file and the Garage credentials.** They are configuration, not data, and they are not
  in the archive on purpose: it would put the instance's runtime secrets next to its contents, under
  one key. Keep them with your other secrets.
