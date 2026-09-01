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

# Resolve the QuestDB volume from the running container instead of guessing.
# Compose prefixes volume names with the project, which defaults to the
# checkout directory, so any hardcoded default is wrong for every clone that
# does not happen to share that directory name. Getting it wrong was silent:
# `docker run -v <unknown>:/data` creates a new empty volume, tars nothing,
# and the script still exits 0 -- a nightly "successful" backup holding the
# Postgres dump but none of the price history.
QDB_MOUNT="${QDB_MOUNT:-/var/lib/questdb}"
if [ -z "${QDB_VOLUME:-}" ]; then
	QDB_VOLUME="$(docker inspect -f \
		"{{range .Mounts}}{{if eq .Destination \"$QDB_MOUNT\"}}{{.Name}}{{end}}{{end}}" \
		"$QDB_CONTAINER" 2>/dev/null || true)"
fi
if [ -z "$QDB_VOLUME" ]; then
	echo "[backup] cannot determine the QuestDB volume mounted at $QDB_MOUNT." >&2
	echo "[backup] is '$QDB_CONTAINER' running? Set QDB_VOLUME to override." >&2
	exit 1
fi
if ! docker volume inspect "$QDB_VOLUME" >/dev/null 2>&1; then
	echo "[backup] QuestDB volume '$QDB_VOLUME' does not exist. Refusing to" >&2
	echo "[backup] continue: docker would create an empty one and archive nothing." >&2
	exit 1
fi

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
echo "[backup] questdb snapshot (volume: $QDB_VOLUME)"
qdb() { curl -sS -G "http://localhost:9000/exec" --data-urlencode "query=$1" >/dev/null; }
qdb "SNAPSHOT PREPARE"
trap 'qdb "SNAPSHOT COMPLETE" || true' EXIT
docker run --rm \
	-v "$QDB_VOLUME":/data:ro \
	-v "$(cd "$OUT" && pwd)":/backup \
	alpine:3.19 tar czf /backup/questdb-data.tar.gz -C /data .
qdb "SNAPSHOT COMPLETE"
trap - EXIT

# Archiving the wrong volume still produces a valid tar, so assert the result
# actually holds QuestDB's data directory before reporting success.
QDB_ENTRIES="$(tar tzf "$OUT/questdb-data.tar.gz" | grep -c '^\./db/' || true)"
if [ "$QDB_ENTRIES" -lt 1 ]; then
	echo "[backup] questdb archive has no ./db entries -- backup is not usable" >&2
	exit 1
fi

# --- Prune ------------------------------------------------------------
# Keep the window bounded; a small VM fills up fast otherwise.
find "$DEST" -maxdepth 1 -type d -name '20*Z' -mtime "+$RETAIN_DAYS" -exec rm -rf {} + 2>/dev/null || true

echo "[backup] done ($QDB_ENTRIES questdb entries):"
du -sh "$OUT"/* | sed 's/^/  /'
