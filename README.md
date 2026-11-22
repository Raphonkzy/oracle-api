# Oracle backend
The server of Oracle, a money tracker for many bank accounts and e-wallets (rupiah). It is a REST API with its own PostgreSQL database, and it runs in Docker on a home server. The phone app is a separate repository (`oracle`) and talks to this one over HTTPS.

```
oracle-api/
├─ api/                       REST API (Hono + Better Auth): every money rule, the AI assistant, and the tests
├─ db/                        Drizzle schema, SQL migrations, the bank and e-wallet catalog, database client
├─ vendor/oracle/             The app repository, pinned as a git submodule. Only shared/core (@oracle/core) is used
├─ backup/backup.sh           Nightly database dump, run by the `backup` service
├─ Dockerfile                 Builds the API image
├─ docker-compose.dev.yml     PostgreSQL only, for development
├─ docker-compose.prod.yml    Production: database, API and nightly backups
├─ deploy.sh                  Pull, back up, build, start, check
├─ create-user.sh             Creates an account while sign-up is closed
├─ reset-password.sh          Sets a new password without the email code
├─ .env.example               Settings for development
├─ .env.production.example    Settings for production
└─ docs/                      API reference, deploy guide, development notes
```

## Get the code
`@oracle/core` (pure logic shared with the app) comes from the app repository, so clone with the submodule:
```bash
git clone --recurse-submodules <url-of-oracle-api>
# or, in an existing clone:
git submodule update --init --recursive
```

## Run it locally
```bash
cp .env.example .env          # then set BETTER_AUTH_SECRET: openssl rand -base64 32
npm install
npm run db:up                 # PostgreSQL in Docker, port 5433
npm run db:migrate && npm run db:seed
npm run dev                   # http://localhost:3200
npm test                      # needs the database running
```
More in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). The API is described in [docs/API.md](docs/API.md), and a test fails when that document and the real routes differ.

## Deploy
Step by step in [docs/DEPLOY.md](docs/DEPLOY.md). In short: fill in `.env.production`, publish `127.0.0.1:3200` through your tunnel or reverse proxy, then `sh deploy.sh`. Every deploy makes a database backup first. Migrations and the catalog run when the API starts.

## Backups
The `backup` service writes `oracle-YYYYMMDD-HHMMSS.sql.gz` into `BACKUP_DIR` (default `./backups`) when it starts and then every 24 hours, and deletes files older than `BACKUP_KEEP_DAYS` (14). Restore into an empty database:
```bash
gunzip -c backups/oracle-20261120-120000.sql.gz | docker compose --env-file .env.production -f docker-compose.prod.yml exec -T db psql -U oracle -d oracle
```
Backups on the same machine do not survive that machine dying. Copy the folder somewhere else regularly (`rsync`, `rclone`). This is not automated.

## What must never be committed
`.env`, `.env.production`, `backups/`, dumps, and keys. `.gitignore` covers them, and only the `*.example` files are tracked.
