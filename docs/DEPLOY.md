# Deploy

From nothing to a running server, and how to move a server that is already running to this repository. The APK and the web version are built from the `oracle` repository (see `docs/BUILD.md` there).

## What you need

Docker with the compose plugin on the server, `git`, and a way to reach port `3200` from the internet (for example the Cloudflare Tunnel already on the server, or a reverse proxy).

## 1. Get the code

This repository is private, so the server needs read access through a dedicated deploy key:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/oracle_deploy -N ""
cat ~/.ssh/oracle_deploy.pub
```

Add the content of the `.pub` file on GitHub: repository `oracle-api`, Settings, Deploy keys, Add deploy key (read only). Then:

```bash
cat >> ~/.ssh/config <<'EOC'
Host github-oracle
  HostName github.com
  User git
  IdentityFile ~/.ssh/oracle_deploy
  IdentitiesOnly yes
EOC
cd ~/apps
git clone github-oracle:<github-username>/oracle-api.git
cd oracle-api
git submodule update --init --recursive
```

`vendor/oracle` is the app repository (public), so its submodule needs no key.

## 2. Production settings

```bash
cp .env.production.example .env.production
chmod 600 .env.production
openssl rand -hex 24      # copy into POSTGRES_PASSWORD
openssl rand -base64 32   # copy into BETTER_AUTH_SECRET
nano .env.production
```

The important values:
- `API_URL`: the public address of the API. It must be `https://`.
- `POSTGRES_PASSWORD` and `BETTER_AUTH_SECRET`: from the commands above.
- `SIGNUP_MODE`: `closed` (only the first account can be created) or `open`.
- `CORS_ORIGINS`: the web addresses allowed to call the API from a browser, separated by commas (for example `https://app.example.com`). Leave it empty if there is no web version. The session cookie only reaches the API when the web app and the API share a site (subdomains of the same domain).
- `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`: an OpenAI-compatible endpoint. Leave `AI_API_KEY` empty to turn the AI off. `AI_RATE_PER_HOUR` limits each person's usage.
- `SMTP_*`: for password reset codes by email. Leave them empty if you do not use email (use `sh reset-password.sh` instead).

This file must never go into git. The repository ignores it.

## 3. Open it to the internet

The API is published only on `127.0.0.1:3200` (see `docker-compose.prod.yml`), so it is not visible on the LAN. Point your tunnel or reverse proxy at `http://127.0.0.1:3200`. Example with a Cloudflare Tunnel that already runs as a service on the server: Zero Trust, Networks, Tunnels, choose the tunnel, Public Hostname, add a hostname with service `HTTP` and URL `127.0.0.1:3200`.

## 4. Deploy

```bash
sh deploy.sh
```

The script runs `git pull`, fetches the submodule, takes a database backup (before any migration), builds the image, starts the containers, waits until they are healthy, and checks `127.0.0.1:3200` and the public address. On the first deploy there is no database yet, so the backup is skipped. If a backup fails, the script stops and changes nothing. Migrations and the bank catalog run when the API starts.

Check from outside: `curl https://<api-address>/api/health` should return `{"ok":true}`.

## 5. Accounts

With `SIGNUP_MODE=closed`, the first account is created from the app, and sign-up is closed after that. More accounts: `sh create-user.sh friend@example.com "Name"`. Forgotten password without email: `sh reset-password.sh person@example.com`.

## Moving the server from the old monorepo

The running server uses one combined repository at `~/apps/oracle`. To move it here without losing data, note that the data lives in the Docker volume `oracle-prod_db-data`, and the compose project name (`oracle-prod`) does not change:

```bash
cd ~/apps
git clone github-oracle:<github-username>/oracle-api.git
cd oracle-api && git submodule update --init --recursive && cd ..
cp oracle/backend/.env.production oracle-api/.env.production
cp -a oracle/backend/backups oracle-api/backups      # old backups
cd oracle && docker compose --env-file backend/.env.production -f backend/docker-compose.prod.yml down   # no -v!
cd ../oracle-api && sh deploy.sh
```

Never use `down -v`: it deletes the database volume. After `deploy.sh` reports `deploy ok` and your data shows in the app, you can archive `~/apps/oracle`.

## Upgrading PostgreSQL

Production runs PostgreSQL 18. A data directory from one major version does not start on another, so a major upgrade is a dump and restore. This procedure is not yet rehearsed on the production server, so test it on a copy first.

1. Take a dump and copy it off the server:
   ```bash
   docker compose --env-file .env.production -f docker-compose.prod.yml exec -T db sh -c 'pg_dumpall -U "$POSTGRES_USER"' > oracle-pg18.sql
   ```
2. In `docker-compose.prod.yml`, set the image to `postgres:19-alpine` and give the volume a new name (in both the `db` service and the `volumes:` section), for example `db-data-19`. The old volume stays untouched.
3. Start only the database, then restore:
   ```bash
   docker compose --env-file .env.production -f docker-compose.prod.yml up -d db
   docker compose --env-file .env.production -f docker-compose.prod.yml exec -T db sh -c 'psql -U "$POSTGRES_USER" -d postgres' < oracle-pg18.sql
   ```
4. Start the API and check your data in the app. Keep the old volume until you are sure.

## After it runs

- Daily backups are in `backups/` (kept for 14 days). Copy them off the server regularly. A backup on the same disk does not help if that disk fails.
- Logs: `docker compose --env-file .env.production -f docker-compose.prod.yml logs -f api`.
- Changed `shared/core`? Make the change in the `oracle` repository first, then here run `git -C vendor/oracle pull && git add vendor/oracle && git commit`.
