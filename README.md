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
ACCOUNTS_READ_TOKEN=
TELEMETRY_SOURCE=
ALLOW_UNAUTHENTICATED_INGEST=0
RUN_MIGRATIONS_ON_START=0
```

Discord OAuth protects `/admin`. `ADMIN_DISCORD_IDS` is a comma-separated allowlist of Discord user IDs. Production should set `PUBLIC_URL`, use its matching OAuth callback URL, and leave secure cookies enabled.

Named bearer credentials created by an admin are the primary machine authentication. A credential belongs to a named telemetry source, has explicit scopes, is displayed only once, and is stored as a salted scrypt hash. The service derives submission `source` from the credential rather than trusting the payload. `TELEMETRY_SECRET` remains only for legacy HMAC producer compatibility and may be unset once all producers use bearer keys.

`ACCOUNTS_READ_TOKEN` is a third, deliberately separate credential for the read-only accounts API (`/accounts/*`). It is held by exactly one consumer — the unbrewed accounts service — so its blast radius is read-only and it can be rotated without touching any producer or sim worker. Leave it unset and those endpoints refuse every request with `503 AUTH_NOT_CONFIGURED`; they never fail open.

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

### `POST /v1/queue-events`

Ingests a batch of matchmaking queue lifecycle events matching
`schemas/queue-events.v1.schema.json`. This is the wait-time feed behind the
future "typical wait" estimate on the matchmaking screen; it is ingest and
storage only, and nothing in it joins to games.

Auth is the **HMAC scheme only** — the same one `/v1/games` accepts from legacy
producers, signing `<timestamp>.<raw request body>` with `TELEMETRY_SECRET`:

```text
X-Unbrewed-Timestamp: <ISO-8601 or unix seconds>
X-Unbrewed-Signature: sha256=<hex>
Content-Type: application/json
```

Bearer `ubk_` credentials are deliberately **not** accepted here: the producer is
the game server itself, and a queue event carries no source attribution for a
named credential to override.

```json
{
  "events": [
    { "type": "search_started", "roomId": "room-91", "heroId": "king-kong", "formatId": "duel", "quickMatch": true, "ts": "2026-08-23T11:59:00.000Z" },
    { "type": "matched", "roomId": "room-91", "heroId": "king-kong", "formatId": "duel", "quickMatch": true, "waitMs": 8200, "ts": "2026-08-23T11:59:08.200Z" },
    { "type": "abandoned", "roomId": "room-92", "heroId": "medusa", "formatId": "duel", "quickMatch": false, "waitMs": 120000, "reason": "expired", "ts": "2026-08-23T11:58:00.000Z" }
  ]
}
```

`waitMs` is optional and only valid on `matched`/`abandoned`; `reason`
(`expired` | `host_left`) is optional and only valid on `abandoned`. Unknown
properties are rejected at every level. A valid batch returns
`201 {"ok": true, "inserted": <n>}`; a bad signature is `401` and a schema or
field/type violation is `400`. The engine POSTs fire-and-forget, so it never
reads the response — deploy order between the two services does not matter.

Rows land in `queue_events` (migration `015`) exactly as received: one row per
event, no dedupe, no aggregation at write time. **Run `npm run db:migrate`
before deploying this code.**

#### Queue wait aggregate

The estimate is a query over the raw stream, not a stored rollup. It lives in
`src/stats/queue-wait.ts` as `QUEUE_WAIT_STATS_SQL` — one definition shared by
the repository (`repo.queueWaitStats({ windowHours })`), the script below, and
whatever read endpoint the UI ticket adds:

```sh
npm run stats:queue-wait            # trailing 24h
npm run stats:queue-wait -- 168     # trailing 7d
```

```json
{
  "windowHours": 24,
  "generatedAt": "2026-08-23T21:37:05.129Z",
  "buckets": [
    { "quickMatch": true, "searchStarted": 4, "matched": 2, "abandoned": 1,
      "matchRate": 0.5, "waitSamples": 2, "medianWaitMs": 9600, "p75WaitMs": 12300 }
  ]
}
```

Per `quick_match` bucket, over the trailing window: median and p75 `wait_ms` for
`matched` searches, and the match rate (`matched / search_started`). Three
choices worth knowing when reading the numbers:

- The percentiles cover `matched` only. A wait on an `abandoned` search is how
  long someone waited before giving up, which is a different question and would
  drag the estimate away from "wait until a match".
- The window is on `received_at` (server clock), not `ts` (producer clock): a
  client with a skewed clock would otherwise fall outside every window or inside
  all of them. `ts` is kept as the producer's own account of when it happened.
- Match rate counts searches still open at the window edge as unmatched, so a
  window much shorter than a typical search reads pessimistic.


### `POST /v1/replays`

Persists the full replay bundle of one finished live game, matching
`schemas/game-replay.v1.schema.json`. `bundle` is the engine's `ReplayBundle`
(`unbrewed-engine/protocol/protocol.ts`): `v`, `engine`, `config`, `actionLog`,
`meta`, and optional `digests`/`digestVersion`. `config` is deliberately not
enumerated — the engine owns its interior.

Auth is the same **HMAC-only** scheme as `/v1/queue-events`. The body cap is
separate from every other route: `MAX_REPLAY_BODY_BYTES`, default 2 MB (the
rest use `MAX_BODY_BYTES`, default 1 MB), because bundles run ~70 KB but carry
cosmetics blobs.

```json
{ "gameId": "live-game-id", "bundle": { "v": 1, "engine": { "schemaVersion": 2, "dslVersion": "0.78.0" }, "config": {}, "actionLog": [{ "type": "END_TURN", "player": "p1" }], "meta": { "turns": 1 } } }
```

Player identity is refused: `displayName`, `playerName` and `email` anywhere in
the bundle, and `name` directly on a `config.players.<seat>` (deeper, `name` is
rules content such as hero and counter names). A new game returns
`201 {"ok": true, "gameId", "duplicate": false}`; a re-post of the same
`gameId` returns `200` with `"duplicate": true` and writes nothing. Bad
signature `401`, wrong content type `415`, oversized body `413`, bad JSON or a
schema violation `400`.

Rows land in `game_replays` (migration `016`), one per game id, with
`engine_schema_version`, `engine_dsl_version`, `digest_version`,
`action_count`, `turns` and `bundle_bytes` copied out of the bundle. There is
no foreign key to `games`: join on `game_id` at read time. **Run
`npm run db:migrate` before deploying this code.**

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

### Accounts read API

Server-to-server only, authenticated with `Authorization: Bearer $ACCOUNTS_READ_TOKEN`. The unbrewed accounts service (`unbrewed-api`) proxies these for a signed-in player; **never expose them to a browser**. Every endpoint here is read-only, excludes sim/campaign games (`games.campaign_id IS NOT NULL` rows never appear), and treat an unknown player id as an empty result rather than a 404 — telemetry does not know the accounts service's user directory, so absence is not an error.

`playerId` is the pseudonymous account uuid the engine stamps on a signed-in player's seat (`game_seats.player_id`).

- `GET /accounts/players/:playerId/games?limit=20&before=<cursor>` returns that player's history newest first:

  ```json
  { "games": [{ "id": "…", "endedAt": "…", "map": "…", "turns": 17, "durationSeconds": 1234,
                "endCondition": "hero_defeated", "draw": false,
                "you": { "heroId": "…", "heroName": "…", "won": true, "finalHealth": 6 },
                "opponents": [{ "heroId": "…", "heroName": "…", "pilot": "bot:hard", "botDifficulty": "hard" }] }],
    "nextBefore": "<cursor|null>" }
  ```

  `you` is the seat whose `player_id` matches; `opponents` is every other seat in the game, teammates included. `limit` defaults to 20 and is capped at 50. `nextBefore` is an **opaque** cursor — pass it back verbatim as `before`; it is `null` when the history is exhausted, and a cursor this API did not issue is a `400 BAD_CURSOR`.

- `GET /accounts/players/:playerId/stats` returns lifetime aggregates:

  ```json
  { "totalGames": 7, "wins": 4, "losses": 2, "draws": 1,
    "byHero": [{ "heroId": "king-kong", "heroName": "King Kong", "games": 4, "wins": 3,
                 "byOpponent": { "human": { "games": 1, "wins": 1 },
                                 "easy":  { "games": 0, "wins": 0 },
                                 "medium":{ "games": 0, "wins": 0 },
                                 "hard":  { "games": 3, "wins": 2 },
                                 "expert":{ "games": 0, "wins": 0 } } }],
    "firstGameAt": "…", "lastGameAt": "…" }
  ```

  `wins` comes from the player's own seat's `won`, `draws` from `games.draw`, and a loss is exactly "my seat did not win and the game was not a draw". `byHero` groups by the player's own seat hero, ordered by games descending.

  `clutchWins` and `fastestBotWinTurns` are the two records the accounts service's `clutch` / `speedrunner` badges are thresholds over (JollyGrin/unbrewed-api#26): wins by the player's own seat, not a draw, that ended in a `hero_defeated` kill against a side holding a **hard or expert** bot — `clutchWins` counts the ones finished at exactly 1 HP, `fastestBotWinTurns` is the smallest `turns` among them (null when there are none). Alone in this file they read `game_seats.bot_difficulty` raw rather than the pilot-label tier of #58: the label maps the starved-hard era (`bot:mc(64, 400ms)`) onto `hard`, which is the right call for win rates and the wrong one for "beat a hard bot in five turns". Stamping the column — live since JollyGrin/unbrewed-engine#366, retroactively via #60 — is what makes a game count. The payload also carries the #54 aggregates — `avgDurationSeconds`/`avgTurns`, `streaks`, `recentForm`, `byOpponentHero`, `byMap`, `byOpponentKind`, `firstPlayer`.

  `byOpponentKind` splits the bot side **by real tier** (#58): the engine has never stamped `game_seats.bot_difficulty` on the live serving path (NULL on 100% of live bot seats), so the tier is decoded from the seat's `pilot` label, which the engine writes from its running preset — `bot:easy` → easy, `bot:mc(16,…)` → medium, `bot:mc(64,…)`/`bot:mc` → hard, `bot:ismcts(…)`/`bot:expert(…)` → expert. A stamped `bot_difficulty` still wins when present. Labels no rule claims (the `bot:mc(sims-…/eps-…/depth-…)` sim knob-grid sweeps) bucket as `unknown` rather than being guessed at; the mapping lives in `src/db/bot-tier.ts` and is unit-tested. Every split row — `byOpponentKind.human`, each bot tier, and both sides of `firstPlayer` — carries `games`, `wins` and `draws`, so a client can read `losses = games - wins - draws` per slice.

  `byHero[].byOpponent` (#63) is the cross of `byHero` and `byOpponentKind` — the per-hero, per-opponent-kind wins the cosmetics point system (unbrewed-p2p#610) is priced off. Five fixed keys, always present and zeroed when unplayed, each `{ games, wins }`. The classification is `byOpponentKind`'s, unchanged: opposing seats only, a game with *any* bot opponent is a bot game, a mixed-tier bot side counts once under its alphabetically first tier, and the tier is the stamped `bot_difficulty` or the decoded pilot label. Two kinds of game land in no bucket and so make the buckets sum to less than the row's `games` — a bot side whose label decodes to `unknown` (there is no key to invent one into), and a game with no opposing seat at all (a producer bug, dropped by `byOpponentKind` too).

  **`byHero[].byOpponent` counts what the cosmetics point system may pay for, not the raw record (#66).** Two per-game anti-farm rules shape it — they live here rather than in unbrewed-api because they are predicates over columns (`games.end_condition`, `games.turns`) the caller never sees, and because points are recomputed on read, so a rule change backfills itself. Everything else in the payload stays raw, the same scoping `minSeconds` has.

  - **Concessions.** For a game whose `end_condition` is `forfeit`, `timeout` or `disconnect` (matched case-insensitively; the list is `CONCESSION_END_CONDITIONS` in `src/db/accounts.ts`), the seat that conceded — the player's own seat, `won = false` — counts toward neither `games` nor `wins`, and the seat conceded to counts toward `games` but earns no `wins`. Nobody profits from a concede in either direction, which is what makes two accounts trading instant concedes worthless. Draws (`simultaneous`) are untouched: both seats played the game out.
  - **Short human wins.** A win in the `human` bucket that took fewer than `MIN_HUMAN_WIN_TURNS` (5) turns counts toward `games` but not `wins`. Bot buckets are exempt — a 2-turn kill on an expert bot is a real result and a bot cannot agree to lose. A NULL `turns` **passes**, deliberately the opposite of the `minSeconds` asymmetry below: a missing turn count is a producer gap on ordinary long games, and treating unknown as short is the mistake that zeroed everyone when the duration floor met a NULL `duration_seconds` column (unbrewed-api#35).

  Two fields feed the player stats dashboard (stats dashboard T2), over the same game set as everything above — the player's own seat, campaigns excluded, every format, every opponent including casual bots:

  - `calendar: [{ date: "YYYY-MM-DD", games }]` — games per UTC day over the last 182 days ending today (UTC; day 182 is today − 181), **only days with games**, oldest first. A game is dated by `COALESCE(ended_at, received_at)` in UTC.
  - `byHeroOpponentHero: [{ heroId, heroName, opponentHeroId, opponentHeroName, games, wins, draws }]` — the player's own hero crossed with the opposing seat's hero, **duel/1v1 games only** (a 2v2 is left out, since a teammate's fight is not the player's matchup), games descending then `heroId`/`opponentHeroId` ascending.

  `?minSeconds=<n>` is an optional anti-farm floor over `byHero[].byOpponent` **and nothing else** — `totalGames`, `byHero[].games`/`wins`, `byOpponentKind` and the records always count the full history, so one call serves both "you played 300 games" and "280 of them count for points". It floors `games.duration_seconds`, the only per-game duration the schema carries (nullable integer, migration `001`; `turns` is the other anti-farm signal and is left to the caller, which already gets `avgTurns`). The default of `0` is *no* filter, null durations included; any positive floor requires a game to have actually reported a duration meeting it, so omitting the field is not a way past the bar. Lenient like `limit`: blank, negative, or unparseable means no floor, and a fractional value truncates rather than 400ing. It stays as upstream contract; unbrewed-api no longer sends it, because `duration_seconds` turned out to be NULL on every live game.

- `GET /accounts/leaderboard?limit=<n>&since=<ISO>` returns the XP inputs for **every** player with at least one completed game — the only cross-player read on this surface:

  ```json
  { "players": [{ "playerId": "…", "gamesPlayed": 123, "wins": 45,
                  "byOpponentKind": { "human": { "games": 80, "wins": 30, "draws": 2 },
                                      "bots": [{ "difficulty": "hard", "games": 43, "wins": 15, "draws": 1 }] },
                  "mainHeroId": "medusa", "mainHeroName": "Medusa",
                  "recentForm": ["W", "L", "W", "W", "D"], "currentStreak": 1,
                  "windowGames": 12, "windowWins": 7 }] }
  ```

  XP is computed api-side from tiered weights telemetry does not know, so rows cannot be pre-sorted by it; they come back `gamesPlayed` descending (`playerId` breaks ties) and the caller sorts. `byOpponentKind` is the same block, with the same semantics, that `/stats` returns — a game with *any* bot opponent is a bot game, opposing seats only, bot rows keyed on the tier decoded from the pilot label — and it is what lets the caller price a human win differently from an easy-bot win instead of weighting everything as human. `limit` is an optional safety cap, not a page size: omit it — or send a blank, unparseable, or non-positive value — and every player is returned. A row is by construction identical to what that player's own `/stats` reports as `totalGames`/`wins`/`byOpponentKind`.

  The leaderboard dashboard fields (stats dashboard T2) are always sent and never touch `gamesPlayed`/`wins`/`byOpponentKind`, which the api prices XP from (a test pins those bytes):

  - `mainHeroId`/`mainHeroName` — the hero with the most games, ties to most wins, then `heroId` ascending; seats with no hero id never qualify, so both are null only for a player with no hero on record. The name is the one the player's latest game on that hero reported.
  - `recentForm` — the last 5 results, newest first; `currentStreak` — consecutive wins ending on the newest game. Both come from the same SQL as `/stats`'s `recentForm`/`streaks.current` (`resultRunsCtes` in `src/db/accounts.ts`), so `recentForm` is always the first five of the player's own list.
  - `?since=<ISO>` adds `windowGames`/`windowWins`: games ending at or after `since`, **excluding** games against a casual (easy/medium) bot. A game's bot tier is `byOpponentKind`'s — any opposing bot makes it a bot game, filed under the alphabetically first tier — and an `unknown` tier is not casual. Players with no games in the window get `0`/`0`. Accepted forms are a date (`2026-09-01`, midnight UTC) or a date-time with `Z` or an offset; anything else, including an empty value or a time without a zone, is `400 BAD_SINCE`.

- `GET /accounts/community?window=all|month` and `GET /accounts/heroes/:heroId?window=all|month` (#72) are the community aggregates behind the stats dashboard's community and per-hero pages (field-by-field shapes: the stats dashboard contract §1a/§1b). Both read **qualifying community games only**: `campaign_id IS NULL AND format IN ('duel','1v1') AND` at least one human seat, so sim campaigns, bot-vs-bot games and team formats never count. Timestamps are `COALESCE(ended_at, received_at)`.

  - `window` is `all` (default, also when blank) or `month` (the current UTC calendar month, echoed back as `windowStart`); anything else is `400 BAD_WINDOW`.
  - **Opponent kind** is the opposing seat's: `human`, `casual` (easy/medium bot) or `hardExpert` (hard, expert, and any tier `bot-tier.ts` cannot decode). A game's kind is `human` when both seats are human, else its human seat's opponent kind.
  - `community` returns `totals` (distinct games by kind, plus `humanVsExpert` human seat-games against an expert bot), `weekly` (always the last 12 Monday-UTC weeks including the current one, oldest first, zero-filled, **ignoring** `window`), `heroes` (human seat-games per hero, so a human-vs-human game counts both seats; games desc, heroId asc) each with its `crown`, and the `matchups` grid over every seat, human or bot, in both orientations (`A|B.games == B|A.games`, no mirrors, no null hero ids).
  - `heroes/:heroId` returns that hero's human seat-games, `totalHumanSeatGames` (the denominator), `pilotCount`, up to 50 signed-in `pilots`, `crown`, its matchup row (`games` desc) and `byOpponentKind`. An unknown hero id is `200` with zeros and empty arrays, never a 404.
  - **Crown**: the signed-in player with the most wins on the hero's human seats; ties go to fewer games, then whoever reached that win count first, then `playerId`. `null` when no signed-in player has a win. `pilots` are in the same order.

```sh
curl -H "Authorization: Bearer $ACCOUNTS_READ_TOKEN" \
  'http://localhost:8788/accounts/players/11111111-1111-4111-8111-111111111111/games?limit=20'
curl -H "Authorization: Bearer $ACCOUNTS_READ_TOKEN" 'http://localhost:8788/accounts/leaderboard'
curl -H "Authorization: Bearer $ACCOUNTS_READ_TOKEN" 'http://localhost:8788/accounts/community?window=month'
curl -H "Authorization: Bearer $ACCOUNTS_READ_TOKEN" 'http://localhost:8788/accounts/heroes/king-kong'
```

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
