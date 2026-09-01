# Deploying GSE Terminal on a VM

<!-- Lives here rather than at /DEPLOYMENT.md, which .gitignore excludes. -->

Single Linux VM running the whole stack under Docker Compose: the Go app,
Postgres, QuestDB, Redis, and Caddy for TLS. Verified against the compose
files in this repo.

## What you need

- A VM with **4 GB RAM minimum** (2 GB QuestDB + 2 GB app; the app image
  carries a headless Chromium for the daily scrape) and ~20 GB disk.
- Docker Engine with the Compose plugin.
- A DNS A/AAAA record for your domain pointing at the VM, resolving
  **before** you start the stack — Caddy requests the certificate on boot.
- Ports 80 and 443 open. Nothing else needs to be reachable.

## First deploy

```bash
sudo mkdir -p /opt/gse-terminal && sudo chown "$USER" /opt/gse-terminal
git clone <repo> /opt/gse-terminal && cd /opt/gse-terminal

cp .env.example .env
```

Edit `.env`. The values that matter for a public deploy:

| Variable | Value |
|---|---|
| `APP_ENV` | `production` (the prod overlay also forces this) |
| `JWT_SECRET` | `openssl rand -hex 32` — production refuses to start under 32 chars |
| `POSTGRES_PASSWORD` | something other than the example |
| `ALLOWED_ORIGINS` | `https://your.domain` — the browser refuses the WebSocket otherwise |
| `APP_BASE_URL` | `https://your.domain` — used for links in alert emails |
| `APP_DOMAIN` | `your.domain` — drives the TLS certificate |
| `ACME_EMAIL` | where Let's Encrypt sends expiry warnings |
| `METRICS_TOKEN` | `openssl rand -hex 32`, or leave empty to disable `/metrics` |
| `GOOGLE_REDIRECT_URL` | `https://your.domain/auth/google/callback` if OAuth is on |

Then bring it up:

```bash
make vm-up          # docker compose -f docker-compose.yaml -f docker-compose.prod.yaml up -d --build
make vm-logs
```

First boot prints a generated `admin` password **once**. Save it.

Survive reboots:

```bash
sudo cp deploy/gse-terminal.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now gse-terminal
```

## What the production overlay changes

`docker-compose.prod.yaml` is an overlay, not a replacement — always pass
both files (the `make vm-*` targets do).

- **Caddy** terminates TLS on 80/443 and proxies to the app. Certificates
  are issued and renewed automatically; they live in the `caddy_data`
  volume, so don't delete it.
- **The app is not published on the host.** Only Caddy is reachable from
  outside. Postgres, QuestDB, and Redis stay bound to `127.0.0.1` for
  local `psql`/backup access.
- **`TRUST_PROXY=true`**, so the app reads the client address from
  `X-Forwarded-For`. Without it every request carries Caddy's address and
  all rate limiters collapse into one bucket — five failed logins would
  lock out every user. Only safe because the app isn't directly reachable.
- **`/metrics` is blocked at the proxy** and, in the app, requires
  `Authorization: Bearer $METRICS_TOKEN`. It stays off entirely when the
  token is unset. Scrape it over the private network or an SSH tunnel.
- **Container logs are capped** at 10 MB x 5 per service. The default
  json-file driver is unbounded and will otherwise fill the disk.
- **Everything restarts unless stopped.**

## Backups

`scripts/backup.sh [dest]` (or `make backup`) dumps Postgres logically and
archives the QuestDB volume between `SNAPSHOT PREPARE` and `SNAPSHOT
COMPLETE`, so the copy is consistent while the database keeps serving.
Older directories are pruned after `BACKUP_RETAIN_DAYS` (14 by default).

Nightly, at 16:30 UTC — an hour after the scrape lands:

```bash
sudo cp deploy/gse-backup.service deploy/gse-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now gse-backup.timer
```

Restore:

```bash
# Postgres — pg_restore can't read custom-format dumps from a pipe, so copy first
gunzip -c backups/<stamp>/postgres-gse_db.dump.gz > /tmp/pg.dump
docker cp /tmp/pg.dump gse_postgres:/tmp/pg.dump
docker exec gse_postgres pg_restore -U gse_user -d gse_db --clean /tmp/pg.dump

# QuestDB — stop the app first so nothing writes mid-restore
docker compose stop app questdb
docker run --rm -v ges_pro_questdb_data:/data -v "$PWD/backups/<stamp>":/b \
  alpine:3.19 sh -c 'rm -rf /data/* && tar xzf /b/questdb-data.tar.gz -C /data'
docker compose start questdb app
```

## Updating

```bash
cd /opt/gse-terminal && git pull && make vm-up
```

The Go binary and UI are baked into the image, so a rebuild is required for
any code change — `restart` alone re-runs the old binary. Schema migrations
run automatically at boot.

## Operational notes

- **The daily scrape** runs at 15:30 UTC and drives a headless Chromium
  inside the app container. It needs the 2 GB limit; if the container is
  OOM-killed each afternoon, that's the cause.
- **Health**: `/healthz` is liveness, `/readyz` checks Postgres, Redis, and
  QuestDB. Both are unauthenticated and safe to expose.
- **Data lives in Docker volumes** (`ges_pro_postgres_data`,
  `ges_pro_questdb_data`). `docker compose down -v` destroys them.
- **Log inspection**: `make vm-logs`. The overlay sets `LOG_FORMAT=json`
  for shipping to a collector.
