# Development

How to run the server on your PC and how to test it. Use Node.js 26 (the current LTS).

## Running

```bash
git submodule update --init --recursive    # @oracle/core lives in vendor/oracle/shared/core
cp .env.example .env                       # set BETTER_AUTH_SECRET (openssl rand -base64 32)
npm install
npm run db:up                              # PostgreSQL 19 in Docker, port 5433
npm run db:migrate && npm run db:seed
npm run dev                                # API at http://localhost:3200
```

`SIGNUP_MODE=closed` allows only the first account. To try things with many accounts, use `open`.

## Tests and checks

```bash
npm test             # api and core; PostgreSQL must be running
npm run typecheck
npm run lint
```

API tests create a temporary database `oracle_test_*` on the same server and drop it afterwards. Development data is not touched. A test compares `docs/API.md` with the real routes.

The AI assistant can also be checked against a real model (costs a little, needs a key in `.env`). This is not part of `npm test`:

```bash
cd api && node --env-file=../.env --import tsx test/live/ai-live.ts
```

## Commands

| Command | What it does |
|---|---|
| `npm run dev` / `start` | Runs the API (with or without watch mode) |
| `npm run db:generate` | Creates a migration from changes in `db/src/schema.ts` |
| `npm run db:migrate` | Applies migrations |
| `npm run db:seed` | Fills the bank and e-wallet catalog (safe to repeat) |
| `npm run db:studio` | Browse the database in the browser |

## Database accounts

- Development: user `oracle`, database `oracle`, port 5433.
- Production: `POSTGRES_USER` from `.env.production`, created from scratch on the first start.

## Developer account with two years of data

Fills one account (created if it does not exist) with 9 accounts, about 2,500 transactions, 330 transfers, and 25 months of budgets, so every screen has content. It goes through the public API like the app does, so all rules apply. It does nothing if the account already has transactions. The password comes from the environment and is never read from a file.

```bash
cd api
SEED_API_URL=http://localhost:3200 SEED_EMAIL=dev@example.com SEED_NAME=Developer SEED_PASSWORD=... node --import tsx src/cli/seed-dev-account.ts
```

It takes five to seven minutes (one request per step). The data is the same every time for the same day (`api/src/cli/dev-data.ts`).
