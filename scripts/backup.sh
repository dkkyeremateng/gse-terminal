#!/usr/bin/env bash
# Back up both databases to a timestamped directory.
#
#   scripts/backup.sh [destination]      # default: ./backups
#
# Postgres (users, watchlists, alert rules, briefings) is dumped logically.
# QuestDB (the price history) is archived from its volume, bracketed by
# SNAPSHOT PREPARE / COMPLETE so the copy is consistent while the database
# keeps serving — a plain tar of a live QuestDB volume can capture a
# half-written column file.
#
# Restore instructions are in deploy/README.md.
set -euo pipefail

DEST="${1:-./backups}"
STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
OUT="$DEST/$STAMP"
RETAIN_DAYS="${BACKUP_RETAIN_DAYS:-14}"

PG_CONTAINER="${PG_CONTAINER:-gse_postgres}"
QDB_CONTAINER="${QDB_CONTAINER:-gse_questdb}"
QDB_VOLUME="${QDB_VOLUME:-ges_pro_questdb_data}"

# POSTGRES_* come from .env; the compose stack uses the same values.
[ -f .env ] && set -a && . ./.env && set +a
PGUSER="${POSTGRES_USER:-gse_user}"
PGDB="${POSTGRES_DB:-gse_db}"

mkdir -p "$OUT"
echo "[backup] -> $OUT"

# --- Postgres ---------------------------------------------------------
echo "[backup] pg_dump $PGDB"
docker exec "$PG_CONTAINER" pg_dump -U "$PGUSER" -d "$PGDB" --format=custom \
	| gzip > "$OUT/postgres-$PGDB.dump.gz"

# --- QuestDB ----------------------------------------------------------
# PREPARE takes a consistent point-in-time view; COMPLETE releases it. The
# trap guarantees release even if the archive step fails, because leaving a
# snapshot open blocks later ones.
echo "[backup] questdb snapshot"
qdb() { curl -sS -G "http://localhost:9000/exec" --data-urlencode "query=$1" >/dev/null; }
qdb "SNAPSHOT PREPARE"
trap 'qdb "SNAPSHOT COMPLETE" || true' EXIT
docker run --rm \
	-v "$QDB_VOLUME":/data:ro \
	-v "$(cd "$OUT" && pwd)":/backup \
	alpine:3.19 tar czf /backup/questdb-data.tar.gz -C /data .
qdb "SNAPSHOT COMPLETE"
trap - EXIT

# --- Prune ------------------------------------------------------------
# Keep the window bounded; a small VM fills up fast otherwise.
find "$DEST" -maxdepth 1 -type d -name '20*Z' -mtime "+$RETAIN_DAYS" -exec rm -rf {} + 2>/dev/null || true

echo "[backup] done:"
du -sh "$OUT"/* | sed 's/^/  /'
