#!/usr/bin/env bash
# Nightly backup of the SQLite database + the session-signing secret.
# The app is sql.js: the whole database lives in memory and gets re-written
# to data/whatsapp.db on every save, so there's no separate backup mechanism
# unless you add one — this is that one. Costs nothing but disk space.
#
# Usage (from the project root, or point --data-dir elsewhere):
#   ./scripts/backup-db.sh
#
# Cron (2am daily, keeps the last 14):
#   0 2 * * * /path/to/project/scripts/backup-db.sh >> /var/log/wa-backup.log 2>&1
#
# In Docker, run it via `docker compose exec app ./scripts/backup-db.sh`
# or point DATA_DIR/BACKUP_DIR at the mounted volume paths from the host.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
DATA_DIR="${DATA_DIR:-$PROJECT_ROOT/data}"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_ROOT/backups}"
KEEP=14   # how many days of backups to retain

mkdir -p "$BACKUP_DIR"

if [ ! -f "$DATA_DIR/whatsapp.db" ]; then
    echo "[backup-db] No database found at $DATA_DIR/whatsapp.db — nothing to back up yet."
    exit 0
fi

stamp="$(date +%Y-%m-%d_%H%M%S)"
dest="$BACKUP_DIR/whatsapp_$stamp.db"

# Plain file copy is safe here: database.js only ever writes the file with a
# single atomic-ish fs.writeFileSync after a full db.export(), not incremental
# writes, so a copy taken between saves is always a complete, valid snapshot.
cp "$DATA_DIR/whatsapp.db" "$dest"

# The session-signing secret matters just as much as the data — losing it
# just logs everyone out, but it's one file, so back it up alongside for free.
if [ -f "$DATA_DIR/.session_secret" ]; then
    cp "$DATA_DIR/.session_secret" "$BACKUP_DIR/session_secret_$stamp"
fi

echo "[backup-db] Saved $dest"

# Prune anything older than KEEP days.
find "$BACKUP_DIR" -name 'whatsapp_*.db' -mtime "+$KEEP" -delete
find "$BACKUP_DIR" -name 'session_secret_*' -mtime "+$KEEP" -delete
