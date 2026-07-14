import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { normalizeSubmission } from '../ingest/normalize.js';
import { wilson } from '../stats/wilson.js';
import { buildDeckProfile, type CardBucketCounts } from '../stats/profile.js';
import { countCards, leanFrom } from '../stats/composition.js';
import type {
  CardContextBucket,
  DashboardStatsResponse,
  DeckComposition,
  DeckDefinitionSubmission,
  DeckDetailResponse,
  DeckProfile,
  DeckStatsResponse,
  GameSubmission,
  IngestCreated,
  IngestDuplicate,
  IngestInvalid,
  NormalizedCard,
  NormalizedGame,
  NormalizedSeat,
  NormalizedTeam,
  SynergyPairMatchupsResponse,
} from '../types.js';

export interface IngestArgs {
  payload: GameSubmission;
  idempotencyKey: string;
  receivedAt: Date;
  authKeyId: string | null;
}

export interface InvalidIngestArgs {
  payload: unknown;
  idempotencyKey: string;
  receivedAt: Date;
  authKeyId: string | null;
  errors: string[];
}

export interface DeckStatsFilters {
  format: string | null;
  pilots: string[];
}

interface DuplicateRow {
  id: string;
  game_id: string | null;
}

export class PgTelemetryRepository {
  constructor(private readonly pool: Pool) {}

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async ingestValid(args: IngestArgs): Promise<IngestCreated | IngestDuplicate> {
    const normalized = normalizeSubmission(args.payload, args.idempotencyKey);
    const submissionId = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const duplicate = await insertSubmission(client, {
        id: submissionId,
        idempotencyKey: args.idempotencyKey,
        source: normalized.source,
        authKeyId: args.authKeyId,
        payload: args.payload,
        validationStatus: 'valid',
        validationErrors: null,
        receivedAt: args.receivedAt,
      });
      if (duplicate) {
        await client.query('ROLLBACK');
        return { kind: 'duplicate', submissionId: duplicate.id, gameId: duplicate.game_id };
      }

      await insertGame(client, submissionId, args.receivedAt, normalized, args.payload);
      await insertTeams(client, normalized.teams);
      await insertSeats(client, normalized.seats);
      await insertCards(client, normalized.cards);
      await client.query('COMMIT');
      return { kind: 'created', submissionId, gameId: normalized.id };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async ingestInvalid(args: InvalidIngestArgs): Promise<IngestInvalid | IngestDuplicate> {
    const submissionId = randomUUID();
    const source = sourceFromPayload(args.payload);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const duplicate = await insertSubmission(client, {
        id: submissionId,
        idempotencyKey: args.idempotencyKey,
        source,
        authKeyId: args.authKeyId,
        payload: args.payload,
        validationStatus: 'invalid',
        validationErrors: args.errors,
        receivedAt: args.receivedAt,
      });
      await client.query('COMMIT');
      if (duplicate) return { kind: 'duplicate', submissionId: duplicate.id, gameId: duplicate.game_id };
      return { kind: 'invalid', submissionId, errors: args.errors };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Upsert a batch of pushed deck definitions into the versioned registry. */
  async upsertDeckDefinitions(payload: DeckDefinitionSubmission, receivedAt: Date): Promise<{ upserted: number }> {
    const source = payload.source ?? 'unknown';
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const deck of payload.decks) {
        const counts = countCards(deck.cards);
        await client.query(
          `
            INSERT INTO deck_definitions (
              deck_id, version, name, tier, source, content_version,
              card_count, attack_count, defense_count, versatile_count, scheme_count,
              attack_value, defense_value, cards, received_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15)
            ON CONFLICT (deck_id, version) DO UPDATE SET
              name = EXCLUDED.name,
              tier = EXCLUDED.tier,
              source = EXCLUDED.source,
              content_version = EXCLUDED.content_version,
              card_count = EXCLUDED.card_count,
              attack_count = EXCLUDED.attack_count,
              defense_count = EXCLUDED.defense_count,
              versatile_count = EXCLUDED.versatile_count,
              scheme_count = EXCLUDED.scheme_count,
              attack_value = EXCLUDED.attack_value,
              defense_value = EXCLUDED.defense_value,
              cards = EXCLUDED.cards,
              received_at = EXCLUDED.received_at
          `,
          [
            deck.deckId,
            deck.version,
            deck.name ?? null,
            deck.tier ?? null,
            source,
            payload.contentVersion ?? null,
            counts.cardCount,
            counts.attack,
            counts.defense,
            counts.versatile,
            counts.scheme,
            counts.attackValue,
            counts.defenseValue,
            JSON.stringify(deck.cards),
            receivedAt,
          ],
        );
      }
      await client.query('COMMIT');
      return { upserted: payload.decks.length };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async deckStats(filters: DeckStatsFilters): Promise<DeckStatsResponse> {
    const pilotFilter = filters.pilots.length > 0 ? filters.pilots : null;
    const summary = await this.pool.query<{ total_games: number; avg_turns: number | null }>(
      `
        WITH filtered_games AS (
          SELECT g.*
          FROM games g
          WHERE ($1::text IS NULL OR g.format = $1)
            AND ($2::text[] IS NULL OR NOT EXISTS (
              SELECT 1
              FROM game_seats s2
              WHERE s2.game_id = g.id
                AND NOT (s2.pilot = ANY($2) OR s2.pilot_kind = ANY($2))
            ))
        )
        SELECT COUNT(*)::int AS total_games, AVG(turns)::float8 AS avg_turns
        FROM filtered_games
      `,
      [filters.format, pilotFilter],
    );
    const totalGames = Number(summary.rows[0]?.total_games ?? 0);
    const avgTurns = summary.rows[0]?.avg_turns ?? null;

    const decks = await this.deckRows(filters.format, pilotFilter, totalGames);

    return {
      totalGames,
      avgTurns,
      decks,
    };
  }

  async dashboardStats(filters: DeckStatsFilters, generatedAt = new Date()): Promise<DashboardStatsResponse> {
    const pilotFilter = filters.pilots.length > 0 ? filters.pilots : null;
    const summary = await this.pool.query<{
      total_games: number;
      avg_turns: number | null;
      first_player_games: number;
      first_player_wins: number;
    }>(
      `
        WITH selected_games AS (
          SELECT g.*
          FROM games g
          WHERE ($1::text IS NULL OR g.format = $1)
            AND ${pilotFilterSql()}
        )
        SELECT
          COUNT(*)::int AS total_games,
          AVG(turns)::float8 AS avg_turns,
          COUNT(*) FILTER (WHERE first_player_team IS NOT NULL AND winner_team IS NOT NULL)::int AS first_player_games,
          COUNT(*) FILTER (WHERE first_player_team IS NOT NULL AND winner_team IS NOT NULL AND first_player_team = winner_team)::int AS first_player_wins
        FROM selected_games g
      `,
      [filters.format, pilotFilter],
    );
    const totalGames = Number(summary.rows[0]?.total_games ?? 0);
    const avgTurns = summary.rows[0]?.avg_turns ?? null;
    const firstPlayerGames = Number(summary.rows[0]?.first_player_games ?? 0);
    const firstPlayerWins = Number(summary.rows[0]?.first_player_wins ?? 0);
    const submissions = await this.pool.query<{ total_submissions: number; invalid_submissions: number }>(
      `
        SELECT
          COUNT(*)::int AS total_submissions,
          COUNT(*) FILTER (WHERE validation_status = 'invalid')::int AS invalid_submissions
        FROM game_submissions
      `,
    );
    const formats = await this.formatRows(pilotFilter);
    const maps = await this.mapRows(filters.format, pilotFilter, totalGames);
    const pilots = await this.pilotRows();
    const decks = await this.deckRows(filters.format, pilotFilter, totalGames);
    const matchups = await this.matchupRows(filters.format, pilotFilter);
    const synergy = await this.synergyRows(filters.format, pilotFilter);

    return {
      generatedAt: generatedAt.toISOString(),
      selectedFormat: filters.format,
      selectedPilots: filters.pilots,
      totalGames,
      totalSubmissions: Number(submissions.rows[0]?.total_submissions ?? 0),
      invalidSubmissions: Number(submissions.rows[0]?.invalid_submissions ?? 0),
      avgTurns,
      firstPlayer: {
        games: firstPlayerGames,
        wins: firstPlayerWins,
        winRate: firstPlayerGames > 0 ? firstPlayerWins / firstPlayerGames : null,
      },
      formats,
      maps,
      pilots,
      decks,
      matchups,
      synergy,
    };
  }

  private async deckRows(format: string | null, pilotFilter: string[] | null, totalGames: number): Promise<DeckStatsResponse['decks']> {
    const rows = await this.pool.query<{
      deck: string;
      deck_id: string;
      deck_version: string;
      hero_id: string | null;
      hero_name: string | null;
      games: number;
      wins: number;
    }>(
      `
        WITH filtered_games AS (
          SELECT g.*
          FROM games g
          WHERE ($1::text IS NULL OR g.format = $1)
            AND ${pilotFilterSql()}
        )
        SELECT
          s.deck,
          s.deck_id,
          s.deck_version,
          MAX(s.hero_id) FILTER (WHERE s.hero_id IS NOT NULL) AS hero_id,
          MAX(s.hero_name) FILTER (WHERE s.hero_name IS NOT NULL) AS hero_name,
          COUNT(*)::int AS games,
          COUNT(*) FILTER (WHERE s.won)::int AS wins
        FROM game_seats s
        JOIN filtered_games g ON g.id = s.game_id
        GROUP BY s.deck, s.deck_id, s.deck_version
        ORDER BY games DESC, s.deck ASC
      `,
      [format, pilotFilter],
    );

    const [profiles, compositions] = await Promise.all([
      this.deckProfileMap(format, pilotFilter),
      this.deckCompositionMap(),
    ]);

    return rows.rows.map((row) => {
      const games = Number(row.games);
      const wins = Number(row.wins);
      const interval = wilson(wins, games);
      const label = row.hero_name ?? row.hero_id ?? row.deck_id;
      return {
        deck: row.deck,
        deckId: row.deck_id,
        deckVersion: row.deck_version,
        label,
        heroId: row.hero_id,
        heroName: row.hero_name,
        games,
        wins,
        pickRate: totalGames > 0 ? games / totalGames : 0,
        winRate: interval.p,
        ciLow: interval.lo,
        ciHigh: interval.hi,
        profile: profiles.get(row.deck) ?? null,
        composition: pickComposition(compositions, row.deck_id, row.deck_version),
      };
    });
  }

  /**
   * Registry compositions keyed by deck id. Each entry keeps every pushed
   * version plus the most recently received one as `latest`, so a game's exact
   * deck version resolves when known and otherwise falls back to latest.
   */
  private async deckCompositionMap(): Promise<Map<string, DeckCompositionEntry>> {
    const rows = await this.pool.query<DeckDefinitionRow>(
      `
        SELECT deck_id, version, name, tier, card_count, attack_count, defense_count,
               versatile_count, scheme_count, attack_value, defense_value
        FROM deck_definitions
        ORDER BY deck_id ASC, received_at DESC
      `,
    );
    const map = new Map<string, DeckCompositionEntry>();
    for (const row of rows.rows) {
      const composition = compositionFromRow(row);
      let entry = map.get(row.deck_id);
      if (!entry) {
        // rows are ordered received_at DESC, so the first per deck is latest.
        entry = { byVersion: new Map(), latest: composition };
        map.set(row.deck_id, entry);
      }
      entry.byVersion.set(row.version, composition);
    }
    return map;
  }

  /** Per-deck play-mix profile derived from game_cards, keyed by full deck id (`<deck>@<version>`). */
  private async deckProfileMap(format: string | null, pilotFilter: string[] | null): Promise<Map<string, DeckProfile>> {
    const rows = await this.pool.query<{ deck: string; context_bucket: CardContextBucket; plays: number }>(
      `
        WITH filtered_games AS (
          SELECT g.*
          FROM games g
          WHERE ($1::text IS NULL OR g.format = $1)
            AND ${pilotFilterSql()}
        )
        SELECT c.deck, c.context_bucket, COUNT(*)::int AS plays
        FROM game_cards c
        JOIN filtered_games g ON g.id = c.game_id
        GROUP BY c.deck, c.context_bucket
      `,
      [format, pilotFilter],
    );
    const counts = new Map<string, CardBucketCounts>();
    for (const row of rows.rows) {
      const entry = counts.get(row.deck) ?? {};
      entry[row.context_bucket] = Number(row.plays);
      counts.set(row.deck, entry);
    }
    const profiles = new Map<string, DeckProfile>();
    for (const [deck, entry] of counts) {
      const profile = buildDeckProfile(entry);
      if (profile) profiles.set(deck, profile);
    }
    return profiles;
  }

  private async formatRows(pilotFilter: string[] | null): Promise<DashboardStatsResponse['formats']> {
    const rows = await this.pool.query<{
      format: string;
      label: string | null;
      games: number;
      share: number | null;
      avg_turns: number | null;
      boss_games: number;
      boss_wins: number;
    }>(
      `
        WITH filtered_games AS (
          SELECT g.*
          FROM games g
          WHERE ${pilotFilterSql(1)}
        )
        SELECT
          format,
          COALESCE(MAX(format_label) FILTER (WHERE format_label IS NOT NULL), format) AS label,
          COUNT(*)::int AS games,
          (COUNT(*)::float8 / NULLIF(SUM(COUNT(*)) OVER (), 0))::float8 AS share,
          AVG(turns)::float8 AS avg_turns,
          COUNT(*) FILTER (WHERE boss IS NOT NULL)::int AS boss_games,
          COUNT(*) FILTER (WHERE boss IS NOT NULL AND winner_team = 0)::int AS boss_wins
        FROM filtered_games
        GROUP BY format
        ORDER BY games DESC, format ASC
      `,
      [pilotFilter],
    );

    const breakdown = await this.bossBreakdown(pilotFilter);

    return rows.rows.map((row) => {
      const bossGames = Number(row.boss_games);
      const bossWins = Number(row.boss_wins);
      return {
        format: row.format,
        label: row.label ?? row.format,
        games: Number(row.games),
        share: row.share ?? 0,
        avgTurns: row.avg_turns,
        bossGames,
        bossWins,
        bossWinRate: bossGames > 0 ? bossWins / bossGames : null,
        bosses: breakdown.get(row.format) ?? [],
      };
    });
  }

  /** Boss-side (teams[0]) win rate split by boss category, keyed by format. */
  private async bossBreakdown(pilotFilter: string[] | null): Promise<Map<string, DashboardStatsResponse['formats'][number]['bosses']>> {
    const rows = await this.pool.query<{ format: string; boss: string; games: number; wins: number }>(
      `
        WITH filtered_games AS (
          SELECT g.*
          FROM games g
          WHERE ${pilotFilterSql(1)}
        )
        SELECT
          format,
          boss,
          COUNT(*)::int AS games,
          COUNT(*) FILTER (WHERE winner_team = 0)::int AS wins
        FROM filtered_games
        WHERE boss IS NOT NULL
        GROUP BY format, boss
        ORDER BY games DESC, boss ASC
      `,
      [pilotFilter],
    );
    const byFormat = new Map<string, DashboardStatsResponse['formats'][number]['bosses']>();
    for (const row of rows.rows) {
      const games = Number(row.games);
      const wins = Number(row.wins);
      const list = byFormat.get(row.format) ?? [];
      list.push({ boss: row.boss, games, wins, winRate: games > 0 ? wins / games : 0 });
      byFormat.set(row.format, list);
    }
    return byFormat;
  }

  private async mapRows(format: string | null, pilotFilter: string[] | null, totalGames: number): Promise<DashboardStatsResponse['maps']> {
    const rows = await this.pool.query<{
      map: string;
      map_version: string | null;
      games: number;
    }>(
      `
        WITH selected_games AS (
          SELECT g.*
          FROM games g
          WHERE ($1::text IS NULL OR g.format = $1)
            AND ${pilotFilterSql()}
        )
        SELECT
          map,
          MAX(map_version) FILTER (WHERE map_version IS NOT NULL) AS map_version,
          COUNT(*)::int AS games
        FROM selected_games
        GROUP BY map
        ORDER BY games DESC, map ASC
        LIMIT 12
      `,
      [format, pilotFilter],
    );
    return rows.rows.map((row) => ({
      map: row.map,
      mapVersion: row.map_version,
      games: Number(row.games),
      share: totalGames > 0 ? Number(row.games) / totalGames : 0,
    }));
  }

  private async pilotRows(): Promise<DashboardStatsResponse['pilots']> {
    const rows = await this.pool.query<{
      pilot: string;
      pilot_kind: 'human' | 'bot' | 'unknown';
      seats: number;
    }>(
      `
        SELECT pilot, pilot_kind, COUNT(*)::int AS seats
        FROM game_seats
        GROUP BY pilot, pilot_kind
        ORDER BY seats DESC, pilot ASC
      `,
    );
    return rows.rows.map((row) => ({
      pilot: row.pilot,
      pilotKind: row.pilot_kind,
      seats: Number(row.seats),
    }));
  }

  private async matchupRows(format: string | null, pilotFilter: string[] | null): Promise<DashboardStatsResponse['matchups']> {
    const rows = await this.pool.query<{
      row_deck: string;
      row_deck_id: string;
      col_deck: string;
      col_deck_id: string;
      games: number;
      wins: number;
    }>(
      `
        WITH duel_games AS (
          SELECT g.*
          FROM games g
          WHERE g.format IN ('duel', '1v1')
            AND ($1::text IS NULL OR g.format = $1)
            AND ${pilotFilterSql()}
        ), oriented AS (
          SELECT
            row_seat.deck AS row_deck,
            row_seat.deck_id AS row_deck_id,
            col_seat.deck AS col_deck,
            col_seat.deck_id AS col_deck_id,
            row_seat.won
          FROM duel_games g
          JOIN game_seats row_seat ON row_seat.game_id = g.id
          JOIN game_seats col_seat ON col_seat.game_id = g.id AND col_seat.team_index <> row_seat.team_index
          WHERE row_seat.seat_index = 0 AND col_seat.seat_index = 0
        )
        SELECT
          row_deck,
          row_deck_id,
          col_deck,
          col_deck_id,
          COUNT(*)::int AS games,
          COUNT(*) FILTER (WHERE won)::int AS wins
        FROM oriented
        GROUP BY row_deck, row_deck_id, col_deck, col_deck_id
        ORDER BY games DESC, row_deck ASC, col_deck ASC
      `,
      [format, pilotFilter],
    );
    return rows.rows.map((row) => {
      const games = Number(row.games);
      const wins = Number(row.wins);
      return {
        rowDeck: row.row_deck,
        rowDeckId: row.row_deck_id,
        colDeck: row.col_deck,
        colDeckId: row.col_deck_id,
        games,
        wins,
        winRate: games > 0 ? wins / games : 0,
      };
    });
  }

  private async synergyRows(format: string | null, pilotFilter: string[] | null): Promise<DashboardStatsResponse['synergy']> {
    const rows = await this.pool.query<{
      deck_a: string;
      deck_a_id: string;
      deck_b: string;
      deck_b_id: string;
      games: number;
      wins: number;
      expected_win_rate: number | null;
    }>(
      `
        WITH twos AS (
          SELECT g.*
          FROM games g
          WHERE g.format IN ('team-2v2', '2v2')
            AND ($1::text IS NULL OR g.format = $1)
            AND ${pilotFilterSql()}
        ), seat_stats AS (
          SELECT
            s.deck,
            COUNT(*)::float8 AS games,
            COUNT(*) FILTER (WHERE s.won)::float8 AS wins
          FROM game_seats s
          JOIN twos g ON g.id = s.game_id
          GROUP BY s.deck
        ), pairs AS (
          SELECT
            CASE WHEN a.deck <= b.deck THEN a.deck ELSE b.deck END AS deck_a,
            CASE WHEN a.deck <= b.deck THEN a.deck_id ELSE b.deck_id END AS deck_a_id,
            CASE WHEN a.deck <= b.deck THEN b.deck ELSE a.deck END AS deck_b,
            CASE WHEN a.deck <= b.deck THEN b.deck_id ELSE a.deck_id END AS deck_b_id,
            a.won
          FROM twos g
          JOIN game_seats a ON a.game_id = g.id
          JOIN game_seats b ON b.game_id = g.id
            AND b.team_index = a.team_index
            AND b.seat_index > a.seat_index
        )
        SELECT
          p.deck_a,
          p.deck_a_id,
          p.deck_b,
          p.deck_b_id,
          COUNT(*)::int AS games,
          COUNT(*) FILTER (WHERE p.won)::int AS wins,
          ((COALESCE(sa.wins / NULLIF(sa.games, 0), 0.5) + COALESCE(sb.wins / NULLIF(sb.games, 0), 0.5)) / 2)::float8 AS expected_win_rate
        FROM pairs p
        LEFT JOIN seat_stats sa ON sa.deck = p.deck_a
        LEFT JOIN seat_stats sb ON sb.deck = p.deck_b
        GROUP BY p.deck_a, p.deck_a_id, p.deck_b, p.deck_b_id, expected_win_rate
        ORDER BY games DESC, deck_a ASC, deck_b ASC
      `,
      [format, pilotFilter],
    );
    return rows.rows.map((row) => {
      const games = Number(row.games);
      const wins = Number(row.wins);
      const winRate = games > 0 ? wins / games : 0;
      const expectedWinRate = row.expected_win_rate ?? 0.5;
      return {
        deckA: row.deck_a,
        deckAId: row.deck_a_id,
        deckB: row.deck_b,
        deckBId: row.deck_b_id,
        games,
        wins,
        winRate,
        expectedWinRate,
        delta: winRate - expectedWinRate,
      };
    });
  }

  /**
   * Deep stats for one deck, powering the hero/deck detail modal.
   * The headline numbers (games, win rate, CI, pick, profile) honor both the
   * format and pilot filters. The breakdowns (by format, by map, matchups, card
   * influence) honor only the pilot filter so the modal stays informative across
   * every format the deck appears in.
   */
  async deckDetail(deck: string, filters: DeckStatsFilters): Promise<DeckDetailResponse> {
    const pilotFilter = filters.pilots.length > 0 ? filters.pilots : null;
    const { deckId, deckVersion } = splitDeckId(deck);

    const totals = await this.pool.query<{ total_games: number }>(
      `
        WITH selected_games AS (
          SELECT g.* FROM games g
          WHERE ($1::text IS NULL OR g.format = $1) AND ${pilotFilterSql()}
        )
        SELECT COUNT(*)::int AS total_games FROM selected_games
      `,
      [filters.format, pilotFilter],
    );
    const totalGames = Number(totals.rows[0]?.total_games ?? 0);

    const baseSel = await this.pool.query<{
      deck_version: string | null;
      hero_id: string | null;
      hero_name: string | null;
      games: number;
      wins: number;
    }>(
      `
        WITH selected_games AS (
          SELECT g.* FROM games g
          WHERE ($1::text IS NULL OR g.format = $1) AND ${pilotFilterSql()}
        )
        SELECT
          MAX(s.deck_version) AS deck_version,
          MAX(s.hero_id) FILTER (WHERE s.hero_id IS NOT NULL) AS hero_id,
          MAX(s.hero_name) FILTER (WHERE s.hero_name IS NOT NULL) AS hero_name,
          COUNT(*)::int AS games,
          COUNT(*) FILTER (WHERE s.won)::int AS wins
        FROM game_seats s
        JOIN selected_games g ON g.id = s.game_id
        WHERE s.deck = $3
      `,
      [filters.format, pilotFilter, deck],
    );
    const selGames = Number(baseSel.rows[0]?.games ?? 0);
    const selWins = Number(baseSel.rows[0]?.wins ?? 0);
    const interval = wilson(selWins, selGames);
    const heroId = baseSel.rows[0]?.hero_id ?? null;
    const heroName = baseSel.rows[0]?.hero_name ?? null;

    const [profiles, compositions] = await Promise.all([
      this.deckProfileMap(filters.format, pilotFilter),
      this.deckCompositionMap(),
    ]);

    const [formats, maps, matchups, cards, broadBase] = await Promise.all([
      this.deckFormatRows(deck, pilotFilter),
      this.deckMapRows(deck, pilotFilter),
      this.deckMatchupRows(deck, pilotFilter),
      this.deckCardRows(deck, pilotFilter),
      this.pool.query<{ games: number; wins: number }>(
        `
          WITH broad_games AS (SELECT g.* FROM games g WHERE ${pilotFilterSql(1)})
          SELECT COUNT(*)::int AS games, COUNT(*) FILTER (WHERE s.won)::int AS wins
          FROM game_seats s JOIN broad_games g ON g.id = s.game_id
          WHERE s.deck = $2
        `,
        [pilotFilter, deck],
      ),
    ]);

    const broadGames = Number(broadBase.rows[0]?.games ?? 0);
    const broadWins = Number(broadBase.rows[0]?.wins ?? 0);
    const baseline = broadGames > 0 ? broadWins / broadGames : 0;

    return {
      found: selGames > 0 || broadGames > 0,
      deck,
      deckId,
      deckVersion: baseSel.rows[0]?.deck_version ?? deckVersion,
      label: heroName ?? heroId ?? deckId,
      heroId,
      heroName,
      games: selGames,
      wins: selWins,
      pickRate: totalGames > 0 ? selGames / totalGames : 0,
      winRate: interval.p,
      ciLow: interval.lo,
      ciHigh: interval.hi,
      profile: profiles.get(deck) ?? null,
      composition: pickComposition(compositions, deckId, deckVersion),
      formats,
      maps,
      matchups,
      cards: cards.map((card) => ({
        ...card,
        baselineWinRate: baseline,
        influence: card.winRateWith - baseline,
      })),
    };
  }

  private async deckFormatRows(deck: string, pilotFilter: string[] | null): Promise<DeckDetailResponse['formats']> {
    const rows = await this.pool.query<{ format: string; label: string | null; games: number; wins: number }>(
      `
        WITH broad_games AS (SELECT g.* FROM games g WHERE ${pilotFilterSql(1)})
        SELECT
          g.format,
          COALESCE(MAX(g.format_label) FILTER (WHERE g.format_label IS NOT NULL), g.format) AS label,
          COUNT(*)::int AS games,
          COUNT(*) FILTER (WHERE s.won)::int AS wins
        FROM game_seats s JOIN broad_games g ON g.id = s.game_id
        WHERE s.deck = $2
        GROUP BY g.format
        ORDER BY games DESC, g.format ASC
      `,
      [pilotFilter, deck],
    );
    return rows.rows.map((row) => {
      const games = Number(row.games);
      const wins = Number(row.wins);
      return { format: row.format, label: row.label ?? row.format, games, wins, winRate: games > 0 ? wins / games : 0 };
    });
  }

  private async deckMapRows(deck: string, pilotFilter: string[] | null): Promise<DeckDetailResponse['maps']> {
    const rows = await this.pool.query<{ map: string; map_version: string | null; games: number; wins: number }>(
      `
        WITH broad_games AS (SELECT g.* FROM games g WHERE ${pilotFilterSql(1)})
        SELECT
          g.map,
          MAX(g.map_version) FILTER (WHERE g.map_version IS NOT NULL) AS map_version,
          COUNT(*)::int AS games,
          COUNT(*) FILTER (WHERE s.won)::int AS wins
        FROM game_seats s JOIN broad_games g ON g.id = s.game_id
        WHERE s.deck = $2
        GROUP BY g.map
        ORDER BY games DESC, g.map ASC
      `,
      [pilotFilter, deck],
    );
    return rows.rows.map((row) => {
      const games = Number(row.games);
      const wins = Number(row.wins);
      return { map: row.map, mapVersion: row.map_version, games, wins, winRate: games > 0 ? wins / games : 0 };
    });
  }

  private async deckMatchupRows(deck: string, pilotFilter: string[] | null): Promise<DeckDetailResponse['matchups']> {
    const rows = await this.pool.query<{
      opp_deck: string;
      opp_deck_id: string;
      hero_name: string | null;
      hero_id: string | null;
      games: number;
      wins: number;
    }>(
      `
        WITH duel_games AS (
          SELECT g.* FROM games g
          WHERE g.format IN ('duel', '1v1') AND ${pilotFilterSql(1)}
        ), oriented AS (
          SELECT
            opp.deck AS opp_deck,
            opp.deck_id AS opp_deck_id,
            opp.hero_name AS hero_name,
            opp.hero_id AS hero_id,
            me.won
          FROM duel_games g
          JOIN game_seats me ON me.game_id = g.id AND me.seat_index = 0 AND me.deck = $2
          JOIN game_seats opp ON opp.game_id = g.id AND opp.seat_index = 0 AND opp.team_index <> me.team_index
        )
        SELECT
          opp_deck,
          opp_deck_id,
          MAX(hero_name) AS hero_name,
          MAX(hero_id) AS hero_id,
          COUNT(*)::int AS games,
          COUNT(*) FILTER (WHERE won)::int AS wins
        FROM oriented
        GROUP BY opp_deck, opp_deck_id
        ORDER BY games DESC, opp_deck ASC
      `,
      [pilotFilter, deck],
    );
    return rows.rows.map((row) => {
      const games = Number(row.games);
      const wins = Number(row.wins);
      return {
        deck: row.opp_deck,
        deckId: row.opp_deck_id,
        label: row.hero_name ?? row.hero_id ?? row.opp_deck_id,
        games,
        wins,
        winRate: games > 0 ? wins / games : 0,
      };
    });
  }

  private async deckCardRows(
    deck: string,
    pilotFilter: string[] | null,
  ): Promise<Omit<DeckDetailResponse['cards'][number], 'baselineWinRate' | 'influence'>[]> {
    const rows = await this.pool.query<{
      card: string;
      bucket: CardContextBucket;
      plays: number;
      games_with: number;
      wins_with: number;
    }>(
      `
        WITH broad_games AS (SELECT g.* FROM games g WHERE ${pilotFilterSql(1)})
        SELECT
          c.card,
          mode() WITHIN GROUP (ORDER BY c.context_bucket) AS bucket,
          COUNT(*)::int AS plays,
          COUNT(DISTINCT c.game_id || ':' || c.team_index || ':' || c.seat_index)::int AS games_with,
          COUNT(DISTINCT c.game_id || ':' || c.team_index || ':' || c.seat_index) FILTER (WHERE c.seat_won)::int AS wins_with
        FROM game_cards c
        JOIN broad_games g ON g.id = c.game_id
        WHERE c.deck = $2
        GROUP BY c.card
        ORDER BY plays DESC, c.card ASC
      `,
      [pilotFilter, deck],
    );
    return rows.rows.map((row) => {
      const gamesWith = Number(row.games_with);
      const winsWith = Number(row.wins_with);
      return {
        card: row.card,
        contextBucket: row.bucket,
        plays: Number(row.plays),
        gamesWith,
        winsWith,
        winRateWith: gamesWith > 0 ? winsWith / gamesWith : 0,
      };
    });
  }

  /**
   * For one 2v2 pair, how it fares against opponents — both as full opposing
   * pairs and as individual opposing decks. Powers the expandable synergy row.
   * Honors format + pilot filters.
   */
  async synergyPairMatchups(
    deckA: string,
    deckB: string,
    filters: DeckStatsFilters,
  ): Promise<SynergyPairMatchupsResponse> {
    const pilotFilter = filters.pilots.length > 0 ? filters.pilots : null;
    const pair = [deckA, deckB].sort();
    // Shared CTE: `opp` = one row per game our pair played, carrying whether our
    // pair won and the opposing team's two decks (sorted).
    const cte = `
      WITH twos AS (
        SELECT g.* FROM games g
        WHERE g.format IN ('team-2v2', '2v2')
          AND ($1::text IS NULL OR g.format = $1)
          AND ${pilotFilterSql()}
      ), team_decks AS (
        SELECT s.game_id, s.team_index,
               array_agg(s.deck ORDER BY s.deck) AS decks,
               bool_or(s.won) AS won
        FROM game_seats s
        JOIN twos g ON g.id = s.game_id
        GROUP BY s.game_id, s.team_index
        HAVING count(*) = 2
      ), our AS (
        SELECT game_id, team_index, won FROM team_decks WHERE decks = $3::text[]
      ), opp AS (
        SELECT o.won, t.decks AS opp_decks
        FROM our o
        JOIN team_decks t ON t.game_id = o.game_id AND t.team_index <> o.team_index
      )`;

    const pairsResult = await this.pool.query<{ deck_a: string; deck_b: string; games: number; wins: number }>(
      `${cte}
        SELECT opp_decks[1] AS deck_a, opp_decks[2] AS deck_b,
               count(*)::int AS games, count(*) FILTER (WHERE won)::int AS wins
        FROM opp
        GROUP BY opp_decks
        ORDER BY games DESC, deck_a ASC`,
      [filters.format, pilotFilter, pair],
    );
    const decksResult = await this.pool.query<{ deck: string; games: number; wins: number }>(
      `${cte}
        SELECT d AS deck, count(*)::int AS games, count(*) FILTER (WHERE won)::int AS wins
        FROM opp, unnest(opp_decks) AS d
        GROUP BY d
        ORDER BY games DESC, deck ASC`,
      [filters.format, pilotFilter, pair],
    );

    const pairs = pairsResult.rows.map((row) => {
      const games = Number(row.games);
      const wins = Number(row.wins);
      return { deckA: row.deck_a, deckB: row.deck_b, games, wins, winRate: games > 0 ? wins / games : 0 };
    });
    const decks = decksResult.rows.map((row) => {
      const games = Number(row.games);
      const wins = Number(row.wins);
      return { deck: row.deck, games, wins, winRate: games > 0 ? wins / games : 0 };
    });
    const totalGames = pairs.reduce((sum, p) => sum + p.games, 0);
    return { found: totalGames > 0, deckA: pair[0]!, deckB: pair[1]!, totalGames, pairs, decks };
  }
}

interface DeckDefinitionRow {
  deck_id: string;
  version: string;
  name: string | null;
  tier: string | null;
  card_count: number;
  attack_count: number;
  defense_count: number;
  versatile_count: number;
  scheme_count: number;
  attack_value: number;
  defense_value: number;
}

interface DeckCompositionEntry {
  byVersion: Map<string, DeckComposition>;
  latest: DeckComposition;
}

function compositionFromRow(row: DeckDefinitionRow): DeckComposition {
  const attackValue = Number(row.attack_value);
  const defenseValue = Number(row.defense_value);
  const cardCount = Number(row.card_count);
  return {
    version: row.version,
    name: row.name,
    tier: row.tier,
    cardCount,
    attack: Number(row.attack_count),
    defense: Number(row.defense_count),
    versatile: Number(row.versatile_count),
    scheme: Number(row.scheme_count),
    attackValue,
    defenseValue,
    lean: cardCount > 0 ? leanFrom(attackValue, defenseValue) : null,
  };
}

// Exact version when the registry has it, else the latest pushed version.
function pickComposition(
  map: Map<string, DeckCompositionEntry>,
  deckId: string,
  version: string | null,
): DeckComposition | null {
  const entry = map.get(deckId);
  if (!entry) return null;
  if (version && entry.byVersion.has(version)) return entry.byVersion.get(version)!;
  return entry.latest;
}

function splitDeckId(deck: string): { deckId: string; deckVersion: string | null } {
  const at = deck.indexOf('@');
  if (at === -1) return { deckId: deck, deckVersion: null };
  return { deckId: deck.slice(0, at), deckVersion: deck.slice(at + 1) };
}

function pilotFilterSql(paramIndex = 2): string {
  return `($${paramIndex}::text[] IS NULL OR NOT EXISTS (
              SELECT 1
              FROM game_seats s2
              WHERE s2.game_id = g.id
                AND NOT (s2.pilot = ANY($${paramIndex}) OR s2.pilot_kind = ANY($${paramIndex}))
            ))`;
}

interface InsertSubmissionArgs {
  id: string;
  idempotencyKey: string;
  source: string | null;
  authKeyId: string | null;
  payload: unknown;
  validationStatus: 'valid' | 'invalid';
  validationErrors: unknown;
  receivedAt: Date;
}

async function insertSubmission(client: PoolClient, args: InsertSubmissionArgs): Promise<DuplicateRow | null> {
  const inserted = await client.query(
    `
      INSERT INTO game_submissions (
        id, idempotency_key, source, auth_key_id, payload, validation_status, validation_errors, received_at
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8)
      ON CONFLICT (idempotency_key) DO NOTHING
    `,
    [
      args.id,
      args.idempotencyKey,
      args.source,
      args.authKeyId,
      JSON.stringify(args.payload),
      args.validationStatus,
      args.validationErrors === null ? null : JSON.stringify(args.validationErrors),
      args.receivedAt,
    ],
  );
  if (inserted.rowCount && inserted.rowCount > 0) return null;
  const existing = await client.query<DuplicateRow>(
    `
      SELECT gs.id, g.id AS game_id
      FROM game_submissions gs
      LEFT JOIN games g ON g.submission_id = gs.id
      WHERE gs.idempotency_key = $1
    `,
    [args.idempotencyKey],
  );
  return existing.rows[0] ?? null;
}

async function insertGame(
  client: PoolClient,
  submissionId: string,
  receivedAt: Date,
  game: NormalizedGame,
  payload: GameSubmission,
): Promise<void> {
  await client.query(
    `
      INSERT INTO games (
        id, submission_id, schema_version, submitted_at, ended_at, received_at, source, format,
        format_label, boss, map, map_version, winner_team, draw, end_condition, turns,
        duration_seconds, first_player_team, engine_schema_version, engine_dsl_version,
        protocol_version, content_version, replay_hash, state_hash, payload
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9, $10, $11, $12, $13, $14, $15, $16,
        $17, $18, $19, $20, $21, $22, $23, $24, $25::jsonb
      )
    `,
    [
      game.id,
      submissionId,
      game.schemaVersion,
      game.submittedAt,
      game.endedAt,
      receivedAt,
      game.source,
      game.format,
      game.formatLabel,
      game.boss,
      game.map,
      game.mapVersion,
      game.winnerTeam,
      game.draw,
      game.endCondition,
      game.turns,
      game.durationSeconds,
      game.firstPlayerTeam,
      game.engineSchemaVersion,
      game.engineDslVersion,
      game.protocolVersion,
      game.contentVersion,
      game.replayHash,
      game.stateHash,
      JSON.stringify(payload),
    ],
  );
}

async function insertTeams(client: PoolClient, teams: NormalizedTeam[]): Promise<void> {
  for (const team of teams) {
    await client.query(
      `
        INSERT INTO game_teams (game_id, team_index, role, won)
        VALUES ($1, $2, $3, $4)
      `,
      [team.gameId, team.teamIndex, team.role, team.won],
    );
  }
}

async function insertSeats(client: PoolClient, seats: NormalizedSeat[]): Promise<void> {
  for (const seat of seats) {
    await client.query(
      `
        INSERT INTO game_seats (
          game_id, team_index, seat_index, runtime_player_id, deck, deck_id, deck_version,
          hero_id, hero_name, pilot, pilot_kind, bot_id, bot_difficulty, bot_version,
          player_id, first_player, won, final_health, final_deck_count, final_hand_count,
          final_discard_count
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12, $13, $14,
          $15, $16, $17, $18, $19, $20,
          $21
        )
      `,
      [
        seat.gameId,
        seat.teamIndex,
        seat.seatIndex,
        seat.runtimePlayerId,
        seat.deck,
        seat.deckId,
        seat.deckVersion,
        seat.heroId,
        seat.heroName,
        seat.pilot,
        seat.pilotKind,
        seat.botId,
        seat.botDifficulty,
        seat.botVersion,
        seat.playerId,
        seat.firstPlayer,
        seat.won,
        seat.finalHealth,
        seat.finalDeckCount,
        seat.finalHandCount,
        seat.finalDiscardCount,
      ],
    );
  }
}

async function insertCards(client: PoolClient, cards: NormalizedCard[]): Promise<void> {
  for (const card of cards) {
    await client.query(
      `
        INSERT INTO game_cards (
          game_id, event_index, team_index, seat_index, deck, deck_id,
          card, turn, context, context_bucket, seat_won
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `,
      [
        card.gameId,
        card.eventIndex,
        card.teamIndex,
        card.seatIndex,
        card.deck,
        card.deckId,
        card.card,
        card.turn,
        card.context,
        card.contextBucket,
        card.seatWon,
      ],
    );
  }
}

function sourceFromPayload(payload: unknown): string | null {
  if (payload && typeof payload === 'object' && 'source' in payload) {
    const source = (payload as { source?: unknown }).source;
    if (typeof source === 'string') return source;
  }
  return null;
}
