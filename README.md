# Unbrewed Telemetry

Telemetry ingest and balance analytics service for Unbrewed.

The service accepts completed game submissions from the private Unbrewed Pro server, stores raw payloads in Postgres, normalizes the MVP balance dimensions, and exposes aggregate deck stats for dashboards.

## Stack

- Node 22
- TypeScript ESM
- npm
- Postgres
- Vitest
- Railway deployment target

## Local setup

```sh
npm install
npm run db:compose:up
npm run db:migrate
cp .env.example .env
npm run dev
```

The local Postgres container listens on port `55432` so it does not collide with a default local Postgres on `5432`. The migration script reads `.env` when present and defaults to the local compose database when `DATABASE_URL` is unset.

## Environment

```sh
PORT=8788
DATABASE_URL=postgres://unbrewed:unbrewed@localhost:55432/unbrewed_telemetry
TELEMETRY_SECRET=dev-telemetry-secret-change-me
TELEMETRY_SOURCE=
ALLOW_UNAUTHENTICATED_INGEST=0
RUN_MIGRATIONS_ON_START=0
```

`TELEMETRY_SECRET` signs ingest requests. Production should keep `ALLOW_UNAUTHENTICATED_INGEST=0`.
`TELEMETRY_SOURCE` labels locally generated simulation/seed submissions; when unset, command-line producers default to `<hostname>:<user>:lab`.

## API

### `GET /` and `GET /dashboard`

Serves the first telemetry dashboard UI. It is inspired by `MockDashboard/` and reads aggregate data from `GET /v1/stats/dashboard`. Keep Railway health checks on `GET /healthz`.

### `GET /healthz`

Returns process health. The `db` field reports whether a simple Postgres ping succeeded.

### `POST /v1/games`

Ingests one completed game matching `schemas/game-submission.v1.schema.json`.

Required request headers:

```text
Content-Type: application/json
Idempotency-Key: <stable game key>
X-Unbrewed-Timestamp: <ISO timestamp or unix timestamp>
X-Unbrewed-Signature: sha256=<hmac hex>
```

The HMAC signs this exact byte sequence:

```text
<timestamp>.<raw request body>
```

Use `src/http/auth.ts`'s `signBody()` helper from Node clients.

### `GET /v1/stats/dashboard`

Returns the aggregate payload used by `/dashboard`: stat cards, format chips, pilot chips, deck rows, map rows, 1v1 matchups, and 2v2 synergy rows.

Query parameters:

- `format`: optional format id, such as `duel` or `team-2v2`.
- `pilots`: optional comma-separated allowed pilot values or pilot kinds. Example: `bot:hard` or `human,bot`.

### `GET /v1/stats/sources`

Returns submission counts grouped by source name for the Submissions → Sources dashboard tab.

Query parameters:

- `format`: optional format id, such as `duel` or `team-2v2`.
- `pilots`: optional comma-separated allowed pilot values or pilot kinds. Example: `bot:hard` or `human,bot`.

### `GET /v1/stats/decks`

Returns aggregate deck balance stats.

Query parameters:

- `format`: optional format id, such as `duel` or `team-2v2`.
- `pilots`: optional comma-separated allowed pilot values or pilot kinds. Example: `bot:hard` or `human,bot`.

Example:

```sh
curl 'http://localhost:8788/v1/stats/decks?format=duel&pilots=bot:hard'
```

### `GET /v1/stats/pilot-comparison`

Compares two exact pilots in 1v1 while holding the opposing pilot constant. Without `hero`, rows compare each active hero across its opponents. With `hero`, rows become that selected hero's win rates against each opposing hero. An optional `opponent` narrows the result to one enemy hero.

Required query parameters: `pilotA`, `pilotB`, and `opponentPilot`. `pilotA` and `pilotB` must differ.

```sh
curl 'http://localhost:8788/v1/stats/pilot-comparison?pilotA=bot:hard(64,2s)&pilotB=bot:hard&opponentPilot=bot:hard'
```

### `GET /v1/stats/deck`

Returns detailed stats for one deck. The dashboard uses the exact 1v1 filters to compare pilot assignments for the same hero matchup.

Query parameters:

- `deck`: required full deck key.
- `format`: optional format id.
- `pilots`: optional broad comma-separated pilot allowlist.
- `opponent`: optional opposing deck key.
- `partner`: optional allied deck key for 2v2.
- `heroPilot`: optional exact pilot value for the selected deck.
- `opponentPilot`: optional exact pilot value for the opposing team.

Example:

```sh
curl 'http://localhost:8788/v1/stats/deck?deck=king-kong@0.1.0&format=duel&opponent=the-mandalorian@0.1.0&heroPilot=bot:hard(64,2s)&opponentPilot=bot:hard'
```

## Submit the sample game

With the dev server running:

```sh
npm run submit:sample
```

Override the target or fixture:

```sh
TELEMETRY_URL=http://localhost:8788/v1/games \
TELEMETRY_SECRET=dev-telemetry-secret-change-me \
SAMPLE_GAME_FILE=examples/sample-game.json \
npm run submit:sample
```

## Tests

Unit tests do not require Postgres:

```sh
npm test
```

To run the Postgres-backed API tests:

```sh
npm run db:compose:up
TEST_DATABASE_URL=postgres://unbrewed:unbrewed@localhost:55432/unbrewed_telemetry npm test
```

The DB tests truncate `game_submissions CASCADE`, so run them only against a disposable database.

## Migrations

Migrations live under `migrations/` and are applied by:

```sh
npm run db:migrate
```

`npm run db:migrate` reads `.env` when present. If `DATABASE_URL` is missing, it uses the local compose URL `postgres://unbrewed:unbrewed@localhost:55432/unbrewed_telemetry`.

The web process does not run migrations by default. Set `RUN_MIGRATIONS_ON_START=1` only for prototype deployments where explicit migration steps are inconvenient.
