#!/bin/sh
# Deploys the backend on the homelab. Run from anywhere: `sh deploy.sh`.
#
#   1. git pull            (only fast-forward, so a surprise merge can never happen here)
#   2. backup             (a fresh dump before the new code can run any migration)
#   3. build and restart  (migrations and the provider catalog run on start)
#   4. health check       (on 127.0.0.1 and at the public address; a failure stops the script with a non-zero exit)
#
# Roll back: `git checkout <previous-commit>` then run this script again. Migrations are forward-only, so if a
# migration already ran, restore the pre-deploy dump it wrote (see README.md, "Restore").
set -eu

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
ENV_FILE=".env.production"
COMPOSE="docker compose --env-file $ENV_FILE -f docker-compose.prod.yml"

[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE" >&2; exit 1; }

echo "==> pulling code"
git pull --ff-only
# The shared logic (@oracle/core) comes from the app repository, pinned as a submodule.
git submodule update --init --recursive
echo "==> code is at $(git rev-parse --short HEAD): $(git log -1 --pretty=%s)"

echo "==> backing up the database before anything changes"
mkdir -p backups
if [ -n "$($COMPOSE ps -q --status running db)" ]; then
  # The dump goes to a file first, so a failed pg_dump stops the script (set -e) instead of leaving an empty backup.
  STAMP="$(date +%Y%m%d-%H%M%S)"
  $COMPOSE exec -T db sh -c 'pg_dump --no-owner -U "$POSTGRES_USER" "$POSTGRES_DB"' > "backups/pre-deploy-$STAMP.sql"
  grep -q "PostgreSQL database dump" "backups/pre-deploy-$STAMP.sql" || { echo "backup does not look like a database dump, stopping" >&2; exit 1; }
  gzip -f "backups/pre-deploy-$STAMP.sql"
  echo "    saved backups/pre-deploy-$STAMP.sql.gz"
else
  echo "    no database is running yet (first deploy): nothing to back up"
fi

echo "==> building and restarting"
# --wait returns only when the containers pass their health checks, and fails if they do not.
$COMPOSE up -d --build --wait

echo "==> checking health"
curl -fsS http://127.0.0.1:3200/api/health >/dev/null 2>&1 || $COMPOSE exec -T api wget -qO- http://127.0.0.1:3200/api/health >/dev/null
API_URL="$(grep '^API_URL=' "$ENV_FILE" | cut -d= -f2-)"
if [ -n "$API_URL" ]; then
  curl -fsS "$API_URL/api/health" >/dev/null && echo "    public address answers: $API_URL"
fi

echo "deploy ok"
