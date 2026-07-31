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
PUBLIC_URL=http://localhost:8788
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
DISCORD_REDIRECT_URI=http://localhost:8788/auth/discord/callback
ADMIN_DISCORD_IDS=
SECURE_COOKIES=0
TELEMETRY_API_KEY=
TELEMETRY_SECRET=dev-telemetry-secret-change-me
TELEMETRY_SOURCE=
ALLOW_UNAUTHENTICATED_INGEST=0
RUN_MIGRATIONS_ON_START=0
```

Discord OAuth protects `/admin`. `ADMIN_DISCORD_IDS` is a comma-separated allowlist of Discord user IDs. Production should set `PUBLIC_URL`, use its matching OAuth callback URL, and leave secure cookies enabled.

Named bearer credentials created by an admin are the primary machine authentication. A credential belongs to a named telemetry source, has explicit scopes, is displayed only once, and is stored as a salted scrypt hash. The service derives submission `source` from the credential rather than trusting the payload. `TELEMETRY_SECRET` remains only for legacy HMAC producer compatibility and may be unset once all producers use bearer keys.

`TELEMETRY_SOURCE` is used only by direct local seed tooling; authenticated HTTP submissions ignore payload-provided source names.

## API

### `GET /` and `GET /dashboard`

Serves the first telemetry dashboard UI. It is inspired by `MockDashboard/` and reads aggregate data from `GET /v1/stats/dashboard`. Keep Railway health checks on `GET /healthz`.

### `GET /healthz`

Returns process health. The `db` field reports whether a simple Postgres ping succeeded.

### `POST /v1/games`

Ingests one completed game matching `schemas/game-submission.v1.schema.json`.

Required request headers for a named bearer credential with `games:submit` scope:

```text
Authorization: Bearer ubk_<key-id>.<secret>
Content-Type: application/json
Idempotency-Key: <stable game key>
```

The credential's source name overrides any `source` field in the payload. Legacy producers may still send `X-Unbrewed-Timestamp` and `X-Unbrewed-Signature`; the HMAC signs `<timestamp>.<raw request body>` with `TELEMETRY_SECRET`.

#### Bot execution metadata

Bot seats may include an optional `botExecution` summary. Keep the stable cohort
or experiment name in `pilot` and the implementation revision in `botVersion`.
The execution block records the requested budget and aggregate work completed
across that seat's decisions in this game:

```json
{
  "deck": "hollow-oak-spice@0.10.0",
  "pilot": "bot:hard(64,2s)",
  "botVersion": "mc-v1",
  "botExecution": {
    "budget": {
      "msPerMove": 2000,
      "iterationCap": 64
    },
    "search": {
      "decisions": 42,
      "completedIterations": {
        "mean": 61.5,
        "p50": 64,
        "p95": 64
      },
      "clockTruncatedDecisions": 3,
      "earlyStoppedDecisions": 0
    }
  }
}
```

`iterationCap` and `completedIterations` are algorithm-neutral names used for
both flat-MC sweeps and ISMCTS iterations. Clock truncation and deterministic
early stopping are separate counts. The service validates the summary and
stores it as JSONB on the normalized seat while preserving the original game
payload. Deploy this ingest change before producers begin sending the field,
because the v1 schema rejects unknown properties.

#### Deck rules fingerprint

Seats may include an optional `deckRulesHash`: a content-derived fingerprint of
the deck's gameplay rules, formatted `<algorithm>-<hex digest>`.

```json
{
  "deck": "hollow-oak-spice@0.10.0",
  "pilot": "bot:hard",
  "deckRulesHash": "fp1-9c3a17b40e21"
}
```

It moves when card values, quantities, effect programs, hero/sidekick stats, or
matched card titles move, and stays put across art, flavor, display name, and
tier changes. That is what `deck@version` cannot do: the version is a single
hand-set `CONTENT_VERSION` shared by every deck, so two different balances can
silently share a label. Storing the fingerprint alongside the version makes each
row self-describing and lets deck balancing attribute a stat change to a
specific rules change.

The algorithm version lives in the prefix and is not pinned by the schema, so a
future `fp2-` canonicalization needs no schema change and cannot collide with
`fp1-` digests. The field is optional and nullable end to end: submissions
without it store `NULL` and behave exactly as before. Deploy this ingest change
and run the migration before producers begin sending the field, because the v1
schema rejects unknown properties.

### `POST /v1/decks`

Upserts versioned deck definitions. Use a named bearer credential with `decks:submit` scope. The credential's source name overrides the payload source.

Each deck may carry the same fingerprint as `rulesHash`, in the same format and
with the same optionality as the seat-level `deckRulesHash` above. It is stored
on `deck_definitions.rules_hash` and surfaced on the deck composition read path.

#### Canonical rules archive

A deck may also carry `rulesCanonical`: the exact string the engine digested to
produce `rulesHash`, as returned by `canonicalDeckRules(hero, cards)`.

```json
{
  "deckId": "king-kong",
  "version": "0.10.0",
  "rulesHash": "fp1-9c3a17b40e21",
  "rulesCanonical": "fp1|hero={\"health\":18,\"id\":\"king-kong\"}|cards=[…]"
}
```

The fingerprint alone says a deck's rules *changed*; the archive says *how* they
changed, which is what deck balancing needs to attribute a win-rate move to a
specific rules edit. It lands in two columns (migration `012`): `rules_canonical`
keeps the bytes verbatim as the integrity anchor, and `rules` keeps the same
content parsed as `{ hero, cards }` so card values, quantities, effect programs
and hero/sidekick stats are queryable in SQL. Read them back with
`repo.deckRulesArchive({ deckId, version, rulesHash })` — deliberately off the
dashboard's composition query, which no view needs and which would grow by
several kilobytes per deck. All 27 shipped decks together are about 127 KB.

**Verification.** On ingest the service recomputes `sha256(rulesCanonical)` and
compares it to `rulesHash`; a disagreement is a `400` — a fingerprint that does
not describe its own rules is worse than no archive at all. The received bytes
are hashed **verbatim**: no re-serialization, no key reordering. Canonicalization
belongs to the engine, and a second implementation of it here would drift.

The `fp<n>-` prefix versions the algorithm, and only algorithms this service
knows (currently `fp1`) are verified. An unknown prefix is **stored unverified,
never rejected**, with a `[decks] …` warning in the log — otherwise the day the
engine ships `fp2` before telemetry is updated, every deck push starts failing.

Both columns are nullable and additive: a push without `rulesCanonical` upserts
exactly as before, historical rows keep their lossy `cards` payload, and no
backfill is performed. **Run `npm run db:migrate` before deploying this code**:
the deck upsert references the new columns unconditionally.

### Admin control plane

`GET /admin` uses Discord OAuth and the `ADMIN_DISCORD_IDS` allowlist. Admins can:

- create named telemetry sources;
- create scoped bearer credentials and copy each secret once;
- revoke credentials;
- manage deck definitions;
- create and inspect simulation campaigns;
- cancel campaigns.

A campaign accepts a shared `spec` plus either `gameCount` or a `games` array containing per-game `spec` overrides. `gameCount` supports 1 through 100,000 games. The admin builder configures checkbox pools for maps and independent hero and pilot pools for every seat, each with an All option, plus starting-player swapping. Registered heroes use stable IDs such as `king-taranis-spice`, not display names or versions. The service deterministically resolves each pool into an exact per-job map, hero, and pilot before runners claim work. Raw JSON mode remains available for custom specs and per-game overrides.

Example campaign body:

```json
{
  "name": "Hard vs medium Thrall",
  "contentVersion": "2026.07",
  "spec": {
    "format": "duel",
    "maps": ["sarpedon"],
    "swapStartingPlayer": true,
    "teams": [
      { "seats": [{ "decks": ["king-taranis-spice", "thrall-spice"], "pilots": ["bot:hard"] }] },
      { "seats": [{ "decks": ["thrall-spice"], "pilots": ["bot:medium", "bot:hard"] }] }
    ]
  },
  "gameCount": 10000
}
```

If `baseSeed` is omitted, the service creates a Unix-nanosecond seed with randomized sub-millisecond bits. Seeds are serialized as decimal strings to preserve 64-bit precision in JavaScript, and each job receives `baseSeed + gameIndex`. That job seed deterministically chooses one entry from `maps`, each seat's `decks`, and each seat's `pilots`; claimed jobs contain exact `map`, `deck`, and `pilot` values.

### Simulation runner API

Runner requests use named bearer credentials. A typical runner credential has `sim:claim`, `sim:complete`, and `games:submit` scopes.

- `POST /v1/sim/claim` with `{ "count": 50, "campaignId": "optional" }` leases up to 100 individual jobs using `FOR UPDATE SKIP LOCKED`.
- `POST /v1/sim/heartbeat` with `{ "jobId", "leaseToken", "leaseDurationMs" }` renews an unexpired lease owned by the same credential.
- `POST /v1/sim/complete` with `{ "jobId", "leaseToken", "game" }` validates and ingests the game, increments campaign progress, and deletes the completed job in one transaction.
- `POST /v1/sim/fail` with `{ "jobId", "leaseToken", "error" }` requeues the game until its maximum attempts, then retains it as a terminal failed job.

Leases are bound to the credential that claimed them. Expired leases are reaped during subsequent claim requests. Successful games retain `campaign_id` and `campaign_game_index` provenance while their transient job rows are deleted.

### `GET /v1/stats/bot-execution`

Returns execution summaries grouped by exact pilot, `botVersion`, and requested
budget. Optional exact filters are `pilot` and `deck`. Cross-game completed
iterations are weighted by decision count; truncation and early-stop rates use
the summed decision count as their denominator.

```sh
curl 'http://localhost:8788/v1/stats/bot-execution?pilot=bot:hard(64,2s)&deck=hollow-oak-spice@0.10.0'
```

This endpoint intentionally does not average per-game p50/p95 values because an
average of percentiles is not a valid combined percentile. The normalized JSONB
and immutable raw payload retain those per-game values for later distribution
analysis.

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

Compares two exact pilots in 1v1 while holding the opposing pilot constant. Without `hero`, rows compare each active hero across its opponents. With `hero`, rows become that selected hero's win rates against each opposing hero, including the mirror matchup even when it has zero games. An optional `opponent` narrows the result to one enemy hero.

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
TELEMETRY_API_KEY='ubk_<key-id>.<secret>' \
SAMPLE_GAME_FILE=examples/sample-game.json \
npm run submit:sample
```

If `TELEMETRY_API_KEY` is unset, the script uses the legacy `TELEMETRY_SECRET` HMAC flow for local compatibility.

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
