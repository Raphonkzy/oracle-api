#!/bin/sh
# Sets a new password for an account when you cannot get the email code. Run it on the homelab:
#   sh reset-password.sh you@example.com
# It asks for the new password (nothing is shown while you type) and sends it to the API container over standard input.
set -eu
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
[ $# -eq 1 ] || { echo "Usage: sh reset-password.sh you@example.com" >&2; exit 2; }
ENV_FILE=".env.production"
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE" >&2; exit 1; }
printf "New password (at least 10 characters): "
stty -echo
trap 'stty echo' EXIT
read -r PASSWORD
stty echo
printf "\nAgain: "
stty -echo
read -r AGAIN
stty echo
printf "\n"
[ "$PASSWORD" = "$AGAIN" ] || { echo "The two passwords are not the same. Nothing was changed." >&2; exit 1; }
printf '%s\n' "$PASSWORD" | docker compose --env-file "$ENV_FILE" -f docker-compose.prod.yml exec -T api node --import tsx src/cli/reset-password.ts "$1"
