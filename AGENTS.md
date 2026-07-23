# AGENTS.md

Guidance for agents working in this repository.

## Project goal

Build the telemetry service for Unbrewed. The first product goal is deck balance: collect completed game records, store them in Postgres, and serve aggregate stats that explain which decks, cards, maps, formats, teams, and bots look overpowered or underpowered.

This service should become the data backend for the balance dashboard prototyped in `MockDashboard/`. It should ingest game submissions from the private Unbrewed Pro server and expose safe aggregate read APIs for dashboards.

## Current repo state

- `MockDashboard/Balance Dashboard.dc.html` is the original frontend mock. It shows the desired balance views: overview, hero table, matchup matrix, pick-vs-win scatter, format cards, 2v2 synergy, and hero detail pages.
- `MockDashboard/mock-data.js` is synthetic dashboard data. Use it to understand required aggregates, not as production data shape.
- `MockDashboard/game-submission.schema.json` is the prototype submission schema. Treat it as a draft. The active v1 ingest schema is `schemas/game-submission.v1.schema.json`.
- `public/dashboard.html` and `public/assets/dashboard.*` are the production dashboard, implemented from the `MockDashboard/Balance Dashboard.dc.html` design. They intentionally use plain static HTML/CSS/JS served by the Node process, with no frontend build step yet. The dashboard renders all six views (overview, heroes, matchups, scatter, formats, synergy) plus a deck-detail modal, and reads `/v1/stats/dashboard` and `/v1/stats/deck`. Deck detail deep-links via `?deck=<deck>` (plus `tab`, `format`, `exclude`).
- The design mock shows a static 30-card deck composition. This now comes from a **versioned deck registry** (`deck_definitions`) that content producers push via `POST /v1/decks`; the dashboard shows real card counts + Σ values + lean when a deck version is registered, and falls back to a play-mix derived from `telemetry.cardsPlayed` (attack/defense/scheme/boost shares) otherwise. The registry keys on `(deck_id, version)`, so historical games keep their exact composition; unknown versions fall back to the latest pushed version, then to the play-mix. The engine publishes its `HEROES` registry to this endpoint on startup when `TELEMETRY_PUSH_DECKS=1` (deck-push client lives in `unbrewed-engine`).

Mock format labels may differ from production ids. The current Unbrewed Pro content registry uses ids such as `duel`, `team-2v2`, `two-v-one-boss`, and `ffa-3`; dashboard labels can still render as `1v1`, `2v2`, `2v1`, and `3FFA`.

The repo may be empty beyond `MockDashboard/` and this file. If scripts, packages, or migrations are absent, create them deliberately and document the commands here.

## Preferred stack

Use Node 22, TypeScript, npm, Postgres, and Railway unless Steven changes direction.

Rationale: `unbrewed-engine` is already a Node 22 TypeScript server on Railway. A Node telemetry service lets us share schema types, test fixtures, replay parsing code, and HTTP client conventions with minimal friction.

Default choices for new backend code:

- TypeScript ESM with strict `tsc`.
- npm, not pnpm or yarn.
- Vitest for tests.
- `tsx` for local execution.
- Postgres as the only durable store.
- Plain SQL migrations or a lightweight migration tool. Ask before introducing a heavy ORM.
- JSON Schema or Zod for request validation. Keep the external payload schema versioned.

## Architecture direction

Keep the engine pure. Do not put HTTP, database, wall-clock, or telemetry side effects inside `engine/` in `unbrewed-engine`.

Telemetry should be emitted by the Unbrewed Pro server layer when a room transitions to finished game state. In the current engine repo, the natural hook is the server path that detects `GAME_OVER`, builds the replay bundle, and broadcasts it. Future integration should add a server-side telemetry client configured by environment variables, for example:

```text
TELEMETRY_URL=https://<telemetry-service>/v1/games
TELEMETRY_API_KEY=<named bearer credential>
```

Submission must be best effort. A telemetry outage must never block gameplay, delay `GAME_OVER`, break replay bundle delivery, or crash the room server. Log failures with enough context to debug them, but do not retry forever in-process.

Recommended flow:

1. Game ends in Unbrewed Pro.
2. Server builds a deterministic replay bundle and a compact telemetry summary.
3. Server submits `POST /v1/games` to this telemetry service with an idempotency key.
4. Telemetry service authenticates the request and enforces size and content-type limits.
5. Telemetry service writes the raw payload with validation status, then derives normalized tables or aggregate jobs for valid submissions.

## Ingestion API shape

Start small and make ingestion boring.

Recommended endpoints:

- `GET /healthz` returns 200 with `{ ok: true }` for Railway health checks.
- `POST /v1/games` ingests one completed game.
- `POST /v1/decks` upserts a batch of deck definitions into the versioned registry (named bearer credential with `decks:submit` scope). Payload schema: `schemas/deck-definitions.v1.schema.json`.
- `GET /v1/stats/dashboard?format=&pilots=` returns all aggregates the dashboard needs (decks with deck profiles, formats with boss-side win rate + by-boss breakdown, maps, pilots, matchups, synergy, first-player).
- `GET /v1/stats/decks?format=&pilots=` returns just the deck table slice.
- `GET /v1/stats/pilot-comparison?pilotA=&pilotB=&opponentPilot=&hero=&opponent=` compares two exact pilots in 1v1 while holding the opposing pilot constant. Without `hero`, rows summarize active heroes; with `hero`, rows list that hero against each opposing hero and always include its mirror matchup. Powers the Pilot Comparisons dashboard tab.
- `GET /v1/stats/deck?deck=&format=&pilots=&opponent=&heroPilot=&opponentPilot=` returns one deck's detail: play-mix profile, win rate by format and map, 1v1 matchups, and per-card influence. The exact pilot parameters support swapping pilot assignments for a fixed 1v1 hero matchup. 404s when the deck has no games under the filters.
- `POST /v1/sim/claim` leases a batch of individual simulation jobs to a bearer credential with `sim:claim` scope.
- `POST /v1/sim/heartbeat` records worker liveness even when idle and optionally renews an unexpired lease owned by the same runner credential. Workers should call it every 5 minutes when no claim, completion, release, failure, or game submission has already recorded activity. The response returns a reusable worker `sessionId`; requests may also report `concurrency` and `workerVersion`.
- `POST /v1/sim/release` returns a runner-owned lease to pending without consuming an attempt, for clean worker shutdowns.
- `POST /v1/sim/complete` atomically ingests a completed game, updates campaign counters, and deletes the transient job row (`sim:complete` scope).
- `POST /v1/sim/fail` requeues or terminally fails a leased job.
- `GET /v1/sim/campaigns/{id}/progress` (any `sim:claim` credential) returns a campaign's per-pilot win rate with a Wilson 95% CI, plus completed/total/failed and a `mixedContentVersion` flag. Added for the unbrewed-engine #248 "ISMCTS road-to-expert" report, which needs a campaign-scoped win-rate view the deck-balance stats do not answer. Reads existing `games`/`game_seats`, no new tables.
- `GET /v1/sim/public/journey?campaigns=grid,arm1,…` (**no auth**, experiment aggregates only) powers the public **Road to Expert+** page at `/road-to-expert` — the ISMCTS mission's campaign ladder (per-step win rate + Wilson CI vs the 60% gate line, chunk progress), auto-refreshing. Per step it also serves live-visibility aggregates (#32): a per-pairing matchup strip, a bucketed cumulative win-rate series (≤60 points) for the gate chart, and an in-flight pulse (leased-job count + median/max checkpoint journal depth). `workers` lists live worker sessions by credential **label** only (never the ubk_ key id) with heartbeat age and a newest-build flag. `minVerdictGames` (50) is the shared "warming up" threshold below which the page suppresses headline win rates. Reads `sim_campaigns`/`sim_jobs`/`sim_worker_sessions` + campaign-scoped `games`/`game_seats`; never a production game. The page also carries a glossary accordion defining every term it uses.
- `GET /v1/admin/fleet` (Discord admin session required) returns the latest worker session per runner credential, including liveness, session games and throughput, active campaign/job leases, reported concurrency, utilization, last-game time, and average game duration. The static `/fleet` page auto-refreshes this view every 10 seconds. Sessions are live for 15 minutes after activity and remain visible as recent offline workers for 24 hours by default.
- `/v1/admin/campaigns` and related admin routes create and inspect deterministic campaigns. Campaigns may use `gameCount` for large repeated runs or explicit per-game overrides. Shared specs use checkbox-style `maps` pools and per-seat `decks`/`pilots` pools with stable hero IDs; the service deterministically resolves pools into exact job specs. `swapStartingPlayer` is first-class, and omitted base seeds default to Unix nanoseconds returned as decimal strings. Active/paused campaigns are arranged into ordered priority tiers via `PUT /v1/admin/campaign/schedule`: lower tiers must finish before later tiers become claimable, while campaigns side by side in one tier are claimed round-robin. Completed/cancelled campaigns are archival and do not participate in scheduling.
- Optional later: `POST /v1/games/batch` for AI lab backfills or simulations.

Machine authentication uses admin-created named bearer credentials over HTTPS. Credentials belong to a telemetry source, are stored as salted scrypt hashes, and carry explicit scopes (`games:submit`, `decks:submit`, `sim:claim`, `sim:complete`). Derive source attribution from the credential and never trust a producer-provided source when bearer auth succeeds. Legacy HMAC remains migration-only. Human administration uses Discord OAuth sessions and an `ADMIN_DISCORD_IDS` allowlist. Never accept machine submissions from browsers.

Every accepted submission should carry or derive:

- `submissionId` or idempotency key, unique per finished game.
- `schemaVersion` for the telemetry payload.
- `receivedAt`, server stamped.
- `submittedAt` or `endedAt`, producer stamped.
- `source`, such as `server`, `manual`, `ai-lab`, or `backfill`.
- Engine version fields, such as protocol version, schema version, DSL version, and content version if available.
- A replay or state hash so duplicates and regressions are detectable.

Store the original JSON payload in an append-only raw table. Derive reporting tables from raw payloads. This preserves future options when metrics change.

## Postgres data model direction

Favor a hybrid model:

- Raw immutable submissions in `game_submissions.payload jsonb`.
- Stable relational tables for high-value query dimensions.
- Derived aggregate views or materialized tables for dashboard speed.

Suggested relational tables:

- `game_submissions`: raw payload, idempotency key, source, auth key id, validation status, received timestamp.
- `games`: one row per completed game. Include format, map, winner team, draw flag, end condition, turn count, duration, engine versions, replay hash, and timestamps.
- `game_teams`: one row per team, including team index and side role, such as boss side.
- `game_seats`: one row per player seat. Include team index, seat index, runtime player id, deck id, deck version, hero id, pilot kind, bot id or difficulty, pseudonymous player id, first-player flag, winner flag, final health, final deck count, final hand count, and final discard count where available.
- `deck_definitions`: versioned deck registry pushed via `POST /v1/decks` (migration `003_deck_definitions.sql`). One row per `(deck_id, version)` with precomputed per-type card counts + Σ values and the raw `cards` jsonb.
- `game_cards`: per-card-play facts derived from `telemetry.cardsPlayed` (migration `002_card_events.sql`). One row per play event, carrying the seat's deck, a normalized context bucket (attack/defense/scheme/boost/discard/other), and the seat's win flag. Powers deck play-mix profiles and card influence.
- `game_actions`: optional detailed action rows derived from replay logs. Use for card and turn analytics.
- `game_events`: optional detailed event rows derived from engine events or replay expansion. Use for combat, damage, movement, and card influence analytics.
- `game_cards`: optional per-card aggregate facts per game and seat, such as drawn, played, boosted, defended, discarded, damage attributed, and turn first played.

Do not over-normalize before the first dashboard works. Raw JSON plus `games`, `game_teams`, and `game_seats` is enough for the MVP balance dashboard.

## Metrics to collect from each completed game

Collect enough data to answer balance questions without collecting personal data.

### Required for MVP balance

Game-level fields:

- Stable game id or idempotency key.
- Source, schema version, submitted timestamp, received timestamp.
- Format id and display label, for example duel, 2v2, boss battle, or FFA.
- Map id and map version or map hash.
- Winner team index, draw flag, and end condition.
- Turn count.
- Wall-clock duration if the server records start and end time.
- First player or first team.
- Engine schema version, DSL version, protocol version, and telemetry schema version.
- Replay bundle hash or final state hash.

Seat-level fields:

- Team index and seat index.
- Runtime player id, such as `p1`, `p2`, and so on.
- Deck id and deck version, for example `king-kong@1.0.0`.
- Hero id and display name if available.
- Pilot type: human or bot.
- Bot id, bot difficulty, and bot version when the seat is a bot.
- Pseudonymous player id only if privacy rules are satisfied.
- Whether this seat or team won.
- Final hero health, final sidekick health if useful, final hand size, final deck count, and final discard count.

Team-level fields:

- Team size.
- Team role, such as boss, challengers, FFA entrant, or normal side.
- Team deck list in seat order.
- Team won flag.

### Derived MVP dashboard metrics

From the fields above, the dashboard should compute:

- Games played by date, source, format, map, and pilot filter.
- Pick rate by deck, format, map, pilot type, and date range.
- Win rate by deck with Wilson confidence intervals.
- Balance flags when confidence interval is fully above or below a threshold.
- 1v1 matchup matrix.
- First-player advantage by format and matchup.
- Map skew by deck and format.
- Boss-side win rate for boss formats.
- 2v2 pair synergy, computed as pair win rate minus expected solo 2v2 win rate.
- Human-only, bot-only, human-vs-bot, and bot difficulty splits.
- Average turns and duration by format, map, deck, and pilot split.

### High-value detailed telemetry

When replay expansion or event capture is available, collect detailed facts for deeper balance work:

Card and hand metrics:

- Cards drawn by seat and turn.
- Cards played by seat, card id, turn, and context: attack, defense, scheme, boost, discard, mill, or effect.
- Cards revealed or committed in combat once public.
- Cards discarded and discard reason.
- Cards boosted, boost value, and whether boost was blind.
- First turn a card was played.
- Win rate when a card was drawn, played, used as attack, used as defense, or used as boost.
- Card influence estimates. Treat these as statistical signals, not proof of causation.

Combat metrics:

- Attacker seat, defender seat, attacking fighter, target fighter, turn number, and map space.
- Attack card id, defense card id, printed values, effective values, value modifiers, item attachments, and boosts.
- Defense declined flag.
- Combat outcome: attacker won, defender won, or unknown where the engine uses ternary outcomes.
- Attack damage, effect damage, prevented damage, and total damage by source.
- Whether a combat defeated a hero or sidekick.
- Follow-up combats, bonus attacks, sub-attacks, and special combat mechanics.

Turn and action metrics:

- Actions per turn and per seat.
- Counts of maneuvers, schemes, attacks, boosts, movement, prompt choices, and forfeits.
- Cards drawn per turn.
- Exhaustion damage and deck-out timing.
- Hand-limit discards.
- Prompt options chosen for card effects.

Map and positioning metrics:

- Starting spaces.
- Movement paths and spaces entered.
- Attack origin and target spaces.
- Range, adjacency, zone, and region facts where derivable.
- Battlefield item usage by space and item id.
- Token placement and destruction facts.

Multiplayer metrics:

- Team composition.
- Seat elimination order.
- Team survival state at game end.
- Boss side versus challenger side stats.
- FFA placement order if the engine can report it later.

Operational metrics:

- Submission validation failures by reason.
- Duplicate submissions.
- Ingest latency and database write latency.
- Aggregate query latency.
- Dashboard API error rates.

## Privacy and safety rules

Do not collect direct personal data for balance work.

Allowed:

- Pseudonymous player id, preferably salted or scoped so it cannot be joined to public identity.
- Coarse user skill bucket if the product later computes one.
- Bot ids and versions.
- Game facts, deck ids, card ids, and replay hashes.

Avoid:

- Player display names.
- Email addresses.
- IP addresses except transiently in Railway logs or rate limiting.
- Browser fingerprints.
- Chat content.
- Secrets in payloads, logs, tests, or fixtures.

Public dashboard endpoints should return aggregates only. Do not expose raw submissions, raw replay bundles, action logs, or per-player histories without explicit authorization.

Treat raw replays and detailed card events as sensitive product data. They can reveal private rule work and play patterns even when they contain no personal data.

## Schema evolution rules

Version every externally submitted payload.

- Keep schemas additive when possible.
- Reject unknown properties at the top level for stable versions.
- When a breaking change is needed, add a new schema file and a new ingest parser.
- Keep old parsers long enough to process queued submissions and historical fixtures.
- Include migration tests for old fixtures.

Prefer storing raw payloads even when derived parsing fails. Mark the submission invalid and store the validation error. This makes producer bugs debuggable.

## Integration with `unbrewed-engine`

Future engine-server changes should be made in the private `unbrewed-engine` repo, not here.

Integration guidelines:

- Add telemetry configuration to the server layer via environment variables.
- Build the telemetry payload from the finished room, final state, seats, format, map, replay bundle, and server timestamps.
- Keep submission async and non-blocking.
- Add an idempotency key based on room id plus final state hash or replay hash.
- Do not include telemetry secrets in replay bundles or client messages.
- Unit-test payload construction without real network calls.
- Add one integration-style test that a game finishing schedules a telemetry submission.
- If the protocol payload changes, follow `unbrewed-engine` protocol version rules in that repo.

## Railway deployment

The service is intended to run on Railway.

Expected production pieces:

- Node web service with `npm start`.
- Railway Postgres plugin or managed Postgres URL.
- `/healthz` endpoint.
- Environment variables for `DATABASE_URL`, ingestion secret, and any dashboard admin secret.
- Migrations run explicitly, not implicitly on every request.

Never commit `.env` files or secrets. Keep `.env.example` safe and fake.

## Development commands

Once implementation starts, keep these commands current:

```sh
npm install
npm test
npm run typecheck
npm run db:compose:up
npm run db:migrate
npm run db:seed
npm run dev
npm start
```

`npm run db:seed` fills the local database with deterministic synthetic games (including fabricated `telemetry.cardsPlayed`) so the dashboard has something to render. Control volume/seed with `SEED_GAMES` and `SEED`. Seeded submissions use `TELEMETRY_SOURCE` as their `source`, defaulting to `<hostname>:<user>:lab` when unset. It writes through the repository, so the server need not be running. Never point it at production.

`npm run sim:seed-credentials -- <host> [<host> ...]` provisions per-host sim-fleet bearer credentials **without** the Discord admin UI or Railway env access (for #248). It creates the `sim-fleet` telemetry source and one credential per host (scopes `sim:claim`, `sim:complete`, `games:submit`) directly in the DB, and writes the plaintext `ubk_…` keys to `sim-credentials.local.json` (gitignored, mode 600) for out-of-band distribution. Only scrypt hashes live in Postgres; **no secret ever touches the repo, a PR, or an issue.**

Other useful commands:

```sh
npm run db:compose:down
npm run submit:sample
TEST_DATABASE_URL=postgres://unbrewed:unbrewed@localhost:55432/unbrewed_telemetry npm test
```

`npm run db:migrate` reads `.env` when present and defaults to the local compose database when `DATABASE_URL` is unset. The DB-backed tests truncate `game_submissions CASCADE`; run them only against a disposable database. If a command changes, update this section in the same change.

## Testing expectations

Minimum tests once backend code exists:

- Schema validation accepts representative valid submissions and rejects malformed submissions.
- Ingest endpoint enforces auth and idempotency.
- Ingest writes raw payloads and normalized rows in one transaction.
- Aggregate queries match hand-built fixtures.
- Wilson interval and balance flag calculations have deterministic tests.
- Bot and human filters match the dashboard semantics from `MockDashboard`.
- Migrations apply cleanly to an empty Postgres database.

Use small fixtures. Do not commit production-like player histories.

## Agent workflow

Before changing code or docs:

1. Inspect the current repo state with `git status`.
2. Read this file and the relevant `MockDashboard/` files.
3. Prefer small, reviewable changes.
4. Update this file when new commands, architecture decisions, or gotchas become true.
5. Run the narrowest useful validation before reporting success.

Do not create a pull request unless Steven asks.
