#!/bin/sh
# Creates an account while sign-up is closed. Run it on the homelab:
#   sh create-user.sh friend@example.com "Friend Name"
# It asks for the password (nothing is shown while you type) and sends it to the API container over standard input.
set -eu
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
[ $# -ge 1 ] || { echo 'Usage: sh create-user.sh friend@example.com "Friend Name"' >&2; exit 2; }
ENV_FILE=".env.production"
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE" >&2; exit 1; }
printf "Password for the new account (at least 10 characters): "
stty -echo
trap 'stty echo' EXIT
read -r PASSWORD
stty echo
printf "\n"
printf '%s\n' "$PASSWORD" | docker compose --env-file "$ENV_FILE" -f docker-compose.prod.yml exec -T api node --import tsx src/cli/create-user.ts "$@"
