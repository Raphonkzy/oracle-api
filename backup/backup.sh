#!/bin/sh
# Dumps the database to /backups on a schedule. Runs inside the `backup` service of docker-compose.prod.yml.
set -eu
mkdir -p /backups
while true; do
  file="/backups/oracle-$(date +%Y%m%d-%H%M%S).sql.gz"
  # Written to a temporary name first, so a half-finished dump is never mistaken for a backup.
  if pg_dump --no-owner | gzip > "$file.tmp" && [ -s "$file.tmp" ]; then
    mv "$file.tmp" "$file"
    echo "backup written: $file ($(wc -c < "$file") bytes)"
  else
    rm -f "$file.tmp"
    echo "backup FAILED" >&2
  fi
  find /backups -name 'oracle-*.sql.gz' -mtime +"${KEEP_DAYS:-14}" -delete
  sleep "${BACKUP_INTERVAL_SECONDS:-86400}"
done
