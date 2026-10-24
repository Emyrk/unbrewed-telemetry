import { createServer, type Server } from 'node:http';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { PgTelemetryRepository } from '../src/db/repository.js';
import { ControlPlaneRepository } from '../src/db/control-plane-repository.js';
import { createApp } from '../src/http/app.js';
import type { GameSubmission, HomeSummaryResponse } from '../src/types.js';
import { sampleGame } from './fixtures.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

const NOW = Date.parse('2026-07-20T12:00:00.000Z');
const DAY = 86_400_000;
const TTL_MS = 60_000;

type Seat = GameSubmission['teams'][number]['seats'][number];
const human = (deck: string, playerId: string): Seat => ({ deck: `${deck}@1.0.0`, pilot: 'human', playerId });
const bot = (deck: string, botId: string, botVersion?: string): Seat => ({
  deck: `${deck}@1.0.0`,
  pilot: `bot:${botId}`,
  ...(botVersion ? { botVersion } : {}),
});

let counter = 0;
function game(
  daysAgo: number,
  teams: Seat[][],
  winner: number,
  extra: Partial<GameSubmission> = {},
): GameSubmission {
  counter += 1;
  const id = `home-${counter}`;
  const submission = sampleGame({
    gameId: id,
    stateHash: id,
    source: 'engine',
    endedAt: new Date(NOW - daysAgo * DAY).toISOString(),
    submittedAt: new Date(NOW - daysAgo * DAY).toISOString(),
    teams: teams.map((seats) => ({ seats })),
    winner,
    ...extra,
  });
  delete submission.telemetry;
  return submission;
}

/**
 * The fixture, relative to NOW (the default 7d window is days 0–7, the
 * previous period days 7–14):
 * - 30 duels, player-a on appa beats expert v2 on king-kong 27 times (OVER/UNDER).
 * - 2 human-vs-human duels, appa vs taranis, one win each (a matrix cell under 3).
 * - 1 2v2 on soulwood: player-d plus expert v2 against two easy bots (one human, three bots).
 * - 1 live bot-only duel, medium vs hard (hidden in the human scope).
 * Live games come from source engine, the first hvh duel from live-server.
 * - 1 campaign sim (source steven), expert v3 mirror, and 2 lab sims
 *   (sources ai-lab, nixos:steven:lab) with lab-bot l9 and expert v9: never
 *   counted, in any scope.
 * - day 10: player-a vs expert v1 (previous period; v1 is played within 14 days but retired by v2).
 * - day 20: player-e vs mc "old" (no game in 14 days: retired).
 * - day 40: player-a vs expert v1 (v1's first appearance).
 */
async function seed(post: (game: GameSubmission) => Promise<void>, pool: Pool): Promise<void> {
  for (let i = 0; i < 30; i += 1) {
    await post(game(1 + i * 0.1, [[human('appa', 'player-a')], [bot('king-kong', 'expert', 'v2')]], i < 27 ? 0 : 1,
      { map: 'mended-drum', firstPlayerTeam: 0, turns: 10 + i, durationSeconds: 600 }));
  }
  await post(game(2, [[human('appa', 'player-b')], [human('taranis', 'player-c')]], 0,
    { map: 'mended-drum', firstPlayerTeam: 1, endCondition: 'forfeit', source: 'live-server' }));
  await post(game(2.5, [[human('appa', 'player-b')], [human('taranis', 'player-c')]], 1,
    { map: 'mended-drum', firstPlayerTeam: 1 }));
  const teamGame = game(3, [
    [human('momo', 'player-d'), bot('piper', 'expert', 'v2')],
    [bot('thetis', 'easy'), bot('narrator', 'easy')],
  ], 0, { format: 'team-2v2', formatLabel: '2v2', map: 'soulwood' });
  delete teamGame.firstPlayerTeam;
  await post(teamGame);
  await post(game(4, [[bot('appa', 'medium')], [bot('taranis', 'hard')]], 0, { map: 'mended-drum' }));
  const sim = game(0.5, [[bot('appa', 'expert', 'v3')], [bot('king-kong', 'expert', 'v3')]], 1,
    { map: 'mended-drum', source: 'steven' });
  await post(sim);
  await pool.query(`INSERT INTO sim_campaigns (id, name, spec, total_games, created_by)
                    VALUES ('camp-1', 'camp', '{}'::jsonb, 1, 'test')`);
  await pool.query(`UPDATE games SET campaign_id = 'camp-1' WHERE id = $1`, [sim.gameId]);
  // Lab sims: no campaign, no human, not a live source. Never counted, in any scope.
  await post(game(1.5, [[bot('appa', 'lab-bot', 'l9')], [bot('taranis', 'expert', 'v9')]], 0,
    { map: 'mended-drum', source: 'ai-lab' }));
  await post(game(2.2, [[bot('appa', 'lab-bot', 'l9')], [bot('king-kong', 'lab-bot', 'l9')]], 1,
    { map: 'lab-map', source: 'nixos:steven:lab' }));
  await post(game(10, [[human('appa', 'player-a')], [bot('king-kong', 'expert', 'v1')]], 0, { map: 'mended-drum' }));
  await post(game(20, [[human('appa', 'player-e')], [bot('king-kong', 'mc', 'old')]], 1, { map: 'mended-drum' }));
  await post(game(40, [[human('appa', 'player-a')], [bot('king-kong', 'expert', 'v1')]], 1, { map: 'mended-drum' }));
}

describeDb('GET /api/home/summary (#97)', () => {
  let pool: Pool;
  let server: Server;
  let baseUrl: string;
  let nowMs = NOW;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    await migrate(pool);
    await pool.query('TRUNCATE game_submissions, deck_definitions, sim_campaigns CASCADE');
    server = createServer(createApp({
      repo: new PgTelemetryRepository(pool),
      cpRepo: new ControlPlaneRepository(pool),
      config: {
        telemetrySecret: '',
        accountsReadToken: '',
        allowUnauthenticatedIngest: true,
        bodyLimitBytes: 1024 * 1024,
        replayBodyLimitBytes: 2 * 1024 * 1024,
        now: () => new Date(nowMs),
        discordClientId: '',
        discordClientSecret: '',
        discordRedirectUri: '',
        adminDiscordIds: [],
        secureCookies: false,
        statsCacheTtlMs: TTL_MS,
      },
    }));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
    baseUrl = `http://127.0.0.1:${address.port}`;
    await seed(async (submission) => {
      const response = await fetch(`${baseUrl}/v1/games`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': submission.gameId! },
        body: JSON.stringify(submission),
      });
      expect(response.status).toBe(201);
    }, pool);
  });

  beforeEach(() => {
    // Step past the previous test's cache entries.
    nowMs = NOW;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await pool.query('TRUNCATE game_submissions, deck_definitions, sim_campaigns CASCADE');
    await pool.end();
  });

  let bust = 0;
  async function summary(query = ''): Promise<HomeSummaryResponse> {
    // A unique ignored parameter keeps each call off the response cache.
    bust += 1;
    const response = await fetch(`${baseUrl}/api/home/summary?${query}&_t=${bust}`);
    expect(response.status).toBe(200);
    return (await response.json()) as HomeSummaryResponse;
  }

  it('counts human games only in the human scope: a one-human-vs-three-bots game counts, bot-only and sim games do not', async () => {
    const body = await summary();
    expect(body.widened).toBe(false);
    expect(body.window).toEqual({
      range: '7d',
      from: '2026-07-13T12:00:00.000Z',
      to: '2026-07-20T12:00:00.000Z',
      previousFrom: '2026-07-06T12:00:00.000Z',
      previousTo: '2026-07-13T12:00:00.000Z',
    });
    expect(body.kpis).toEqual({
      games: 33,
      uniqueHumans: 4,
      newHumans: 3,
      humanSeatsVsBots: 31,
      humanWinsVsBots: 28,
      humanWinRateVsBots: 28 / 31,
      medianTurns: 23,
      medianDurationSeconds: 600,
      endedEarly: 1,
      botOnlyGames: 0,
    });
    // The live medium-vs-hard duel only; the two lab bot-only games are not live.
    expect(body.hiddenBotGames).toBe(1);
    expect(body.maps.map((m) => m.map)).toEqual(['mended-drum', 'soulwood']);
  });

  it('reports the previous period: the same lens shifted back one window', async () => {
    const body = await summary();
    expect(body.previous).toMatchObject({ games: 1, uniqueHumans: 1, humanSeatsVsBots: 1, humanWinsVsBots: 1 });
  });

  it('puts live bot-only games back in scope=all and hides nothing', async () => {
    const body = await summary('scope=all');
    expect(body.kpis.games).toBe(34);
    expect(body.kpis.botOnlyGames).toBe(1);
    expect(body.hiddenBotGames).toBe(0);
  });

  it('never counts lab or campaign sims, not even under scope=all', async () => {
    for (const scope of ['human', 'all']) {
      const body = await summary(`scope=${scope}&range=30d`);
      expect(body.maps.map((m) => m.map)).not.toContain('lab-map');
      const versions = [...body.bots.current, ...body.bots.retired.rows].map((b) => `${b.botId}:${b.botVersion}`);
      expect(versions).not.toContain('lab-bot:l9');
      expect(versions).not.toContain('expert:v9');
      expect(versions).not.toContain('expert:v3');
      const pinned = await summary(`scope=${scope}&bot=lab-bot`);
      expect(pinned.kpis.games).toBe(0);
      expect(pinned.hiddenBotGames).toBe(0);
      expect(pinned.widened).toBe(false);
    }
    const all = await summary('scope=all&range=30d');
    expect(all.kpis.games).toBe(36);
    expect(all.bots.retired.versions).toBe(2);
  });

  it('keeps the latest version per bot with a game in the last 14 days current and counts the rest retired', async () => {
    const body = await summary();
    expect(body.bots.current.map((b) => [b.botId, b.botVersion, b.games, b.humanSeats, b.humanWins])).toEqual([
      ['easy', null, 1, 1, 1],
      ['expert', 'v2', 31, 31, 28],
    ]);
    // expert v1 (played on day 10, superseded by v2) and mc "old" (day 20).
    expect(body.bots.retired).toEqual({ versions: 2, games: 0, rows: [] });

    // scope=all adds medium/hard from the live bot-only game; the sims' expert
    // v3 and v9, though newer, are not live and never become current.
    const all = await summary('scope=all');
    expect(all.bots.current.map((b) => `${b.botId}:${b.botVersion}`)).toEqual([
      'easy:null', 'expert:v2', 'hard:null', 'medium:null',
    ]);
    expect(all.bots.retired).toEqual({ versions: 2, games: 0, rows: [] });
  });

  it('flags decks OVER/UNDER only past n >= 30 with the Wilson band clear of 45–55', async () => {
    const body = await summary();
    expect(body.decks.mode).toBe('decks');
    const rows = Object.fromEntries(body.decks.rows.map((r) => [r.deck, r]));
    expect(rows['appa']).toMatchObject({ games: 32, wins: 28, flag: 'OVER' });
    expect(rows['king-kong']).toMatchObject({ games: 30, wins: 3, flag: 'UNDER' });
    expect(rows['taranis']).toMatchObject({ games: 2, wins: 1, flag: null });
    expect(rows['appa']!.lo).toBeGreaterThan(0.55);
    expect(body.decks.rows[0]!.deck).toBe('momo');
  });

  it('turns the deck panel into deck-vs-opponents when a deck is pinned', async () => {
    const body = await summary('deck=appa');
    expect(body.kpis.games).toBe(32);
    expect(body.decks).toMatchObject({ mode: 'vs', deck: 'appa' });
    expect(body.decks.rows.map((r) => [r.deck, r.games, r.wins, r.flag])).toEqual([
      ['king-kong', 30, 27, 'OVER'],
      ['taranis', 2, 1, null],
    ]);
    const pair = await summary('deck=appa&vs=taranis');
    expect(pair.kpis.games).toBe(2);
  });

  it('hides matrix cells under 3 games', async () => {
    const body = await summary();
    expect(body.matrix.minGames).toBe(3);
    expect(body.matrix.cells).toEqual([
      { deck: 'appa', vs: 'king-kong', games: 30, wins: 27, winRate: 0.9 },
      { deck: 'king-kong', vs: 'appa', games: 30, wins: 3, winRate: 0.1 },
    ]);
    // appa/taranis both ways (2 games) and the eight 2v2 cross pairs (1 game).
    expect(body.matrix.hiddenCells).toBe(10);
    expect(body.matrix.decks).toEqual(['appa', 'king-kong', 'momo', 'narrator', 'piper', 'taranis', 'thetis']);
  });

  it('reports the first-player edge per map over games that reported a first player', async () => {
    const body = await summary();
    expect(body.maps).toEqual([
      { map: 'mended-drum', games: 32, firstPlayerGames: 32, firstPlayerWins: 28, firstPlayerEdge: 28 / 32 },
      { map: 'soulwood', games: 1, firstPlayerGames: 0, firstPlayerWins: 0, firstPlayerEdge: null },
    ]);
  });

  it('narrows per-seat rates to the pinned player', async () => {
    const body = await summary('player=player-b');
    expect(body.kpis.games).toBe(2);
    expect(body.decks.rows.map((r) => [r.deck, r.games, r.wins])).toEqual([['appa', 2, 1]]);
    expect(body.matrix.hiddenCells).toBe(1);
  });

  it('auto-widens an empty 7d window to 30d', async () => {
    nowMs = NOW + 10 * DAY;
    const body = await summary();
    expect(body.widened).toBe(true);
    expect(body.window.range).toBe('30d');
    expect(body.window.from).toBe(new Date(nowMs - 30 * DAY).toISOString());
    // Days 10–40 before the new now: everything but the day-40 game, minus bot-only and sim.
    expect(body.kpis.games).toBe(35);
    expect(body.lens.range).toBe('7d');
  });

  it('serves a pinned retired version through the widened window', async () => {
    const body = await summary('ver=expert:v1');
    expect(body.widened).toBe(true);
    expect(body.kpis.games).toBe(1);
    expect(body.bots.retired.games).toBe(1);
    expect(body.bots.retired.rows.map((b) => [b.botId, b.botVersion, b.games])).toEqual([['expert', 'v1', 1]]);
  });

  it('does not widen when 30d is empty too, nor for an explicit range', async () => {
    const none = await summary('map=nowhere');
    expect(none.widened).toBe(false);
    expect(none.window.range).toBe('7d');
    expect(none.kpis.games).toBe(0);

    nowMs = NOW + 10 * DAY;
    const day = await summary('range=24h');
    expect(day.widened).toBe(false);
    expect(day.kpis.games).toBe(0);
  });

  it('serves a 30-day timeline under the scope and pins but not the window (#98)', async () => {
    const body = await summary('range=24h');
    expect(body.timeline).toHaveLength(30);
    expect(body.timeline[0]!.day).toBe('2026-06-21');
    expect(body.timeline[29]!.day).toBe('2026-07-20');
    // Every human game but the day-40 one, whatever the range.
    expect(body.timeline.reduce((sum, d) => sum + d.games, 0)).toBe(35);
    expect(body.timeline.find((d) => d.day === '2026-06-30')!.games).toBe(1);

    const pinned = await summary('deck=taranis');
    expect(pinned.timeline.filter((d) => d.games > 0)).toEqual([{ day: '2026-07-18', games: 2 }]);
    const all = await summary('deck=taranis&scope=all');
    expect(all.timeline.find((d) => d.day === '2026-07-16')!.games).toBe(1);
  });

  it('answers a bad lens value with 400 naming the key', async () => {
    const response = await fetch(`${baseUrl}/api/home/summary?range=1y`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, code: 'BAD_LENS', key: 'range' });
  });

  it('carries the stats cache headers and answers a matching If-None-Match with 304', async () => {
    const url = `${baseUrl}/api/home/summary?scope=human&range=7d`;
    const first = await fetch(url);
    expect(first.status).toBe(200);
    expect(first.headers.get('x-stats-cache')).toBe('miss');
    expect(first.headers.get('cache-control')).toBe('public, max-age=60, stale-while-revalidate=60');
    const etag = first.headers.get('etag');
    expect(etag).toMatch(/^W\/".+"$/);
    const second = await fetch(url, { headers: { 'if-none-match': etag! } });
    expect(second.status).toBe(304);
    expect(second.headers.get('x-stats-cache')).toBe('hit');
  });
});
