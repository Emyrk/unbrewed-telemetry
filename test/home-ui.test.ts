import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ControlPlaneRepository } from '../src/db/control-plane-repository.js';
import { PgTelemetryRepository } from '../src/db/repository.js';
import { createApp } from '../src/http/app.js';

// home.js is a browser module; its pure helpers are exported for these tests.
const home = await import(new URL('../public/assets/home.js', import.meta.url).href);

const SUMMER = new Date('2026-07-01T12:00:00Z');
const empty = () => Array.from({ length: 7 }, () => new Array<number>(24).fill(0));

describe('When people play: UTC buckets rotated into the viewer zone (#98)', () => {
  it('reads the zone offset and its short name for two zones', () => {
    expect(home.utcOffsetMinutes('Europe/Berlin', SUMMER)).toBe(120);
    expect(home.utcOffsetMinutes('America/New_York', SUMMER)).toBe(-240);
    expect(home.utcOffsetMinutes('Europe/Berlin', new Date('2026-12-01T12:00:00Z'))).toBe(60);
    expect(home.zoneLabel('Europe/Berlin', SUMMER)).toBe('CEST');
    expect(home.zoneLabel('America/New_York', SUMMER)).toBe('EDT');
  });

  it('moves each UTC cell to the local day and hour, wrapping across days and the week', () => {
    const grid = empty();
    grid[1]![14] = 5; // Mon 14:00 UTC
    grid[1]![1] = 3; // Mon 01:00 UTC
    grid[6]![23] = 2; // Sat 23:00 UTC

    const berlin = home.rotateGrid(grid, home.hourShift(120));
    expect(berlin[1][16]).toBe(5);
    expect(berlin[1][3]).toBe(3);
    expect(berlin[0][1]).toBe(2); // Sat 23 UTC is Sun 01 in Berlin

    const ny = home.rotateGrid(grid, home.hourShift(-240));
    expect(ny[1][10]).toBe(5);
    expect(ny[0][21]).toBe(3); // Mon 01 UTC is still Sunday evening in New York
    expect(ny[6][19]).toBe(2);

    for (const rotated of [berlin, ny]) {
      expect(rotated.flat().reduce((a: number, b: number) => a + b, 0)).toBe(10);
    }
  });

  it('rounds half-hour zones to the nearest whole hour (approximate by design)', () => {
    expect(home.utcOffsetMinutes('Asia/Kolkata', SUMMER)).toBe(330);
    expect(home.hourShift(330)).toBe(6);
    expect(home.hourShift(345)).toBe(6); // Nepal +5:45
    const grid = empty();
    grid[2]![10] = 1;
    expect(home.rotateGrid(grid, home.hourShift(330))[2][16]).toBe(1);
  });

  it('writes the peak sentence in local time, 24h or 12h', () => {
    const peak = [{ dow: 2, hour: 14, n: 9 }, { dow: 3, hour: 15, n: 8 }, { dow: 4, hour: 14, n: 7 }];
    expect(home.peakSentence(peak, 2, '24')).toBe('Busiest: weekdays 16:00 to 18:00 your time.');
    expect(home.peakSentence(peak, 2, '12')).toBe('Busiest: weekdays 4 pm to 6 pm your time.');
    expect(home.peakSentence(peak, -4, '24')).toBe('Busiest: weekdays 10:00 to 12:00 your time.');
    expect(home.peakSentence([{ dow: 6, hour: 23, n: 4 }], 2, '24')).toBe('Busiest: Sundays 01:00 to 02:00 your time.');
    expect(home.peakSentence([], 0, '24')).toBe('No games in the last 28 days yet.');
  });

  it('renders the panel with the zone label, darkest cell = busiest, and the lens note', () => {
    const grid = empty();
    grid[2]![14] = 9;
    grid[3]![15] = 3;
    const activity = { grid, peak: [{ dow: 2, hour: 14, n: 9 }, { dow: 3, hour: 15, n: 3 }], total: 12 };
    const berlin = home.renderActivity({ activity, clock: '24', timeZone: 'Europe/Berlin', now: SUMMER });
    expect(berlin).toContain('your time (CEST)');
    expect(berlin).toContain('Tue 16:00–17:00 your time: 9 games');
    expect(berlin).toContain('All games with a human, last 28 days');
    expect(berlin).toContain('does not change this panel');
    const ny = home.renderActivity({ activity, clock: '12', timeZone: 'America/New_York', now: SUMMER });
    expect(ny).toContain('your time (EDT)');
    expect(ny).toContain('Tue 10 am–11 am your time: 9 games');
    expect(home.heatColor(9, 9)).toBe('rgb(110, 53, 16)');
    expect(home.heatColor(0, 9)).toBe('rgb(244, 236, 220)');
  });
});

describe('landing lens helpers (#98)', () => {
  it('parses the URL lens once with the defaults and writes it back in key order', () => {
    const lens = home.parseLens('?deck=appa&tab=x&map=%20');
    expect(lens).toMatchObject({ scope: 'human', range: '7d', deck: 'appa', map: null });
    expect(home.lensQuery(lens)).toBe('scope=human&range=7d&deck=appa');
    expect(home.lensQuery(home.withDays(lens, '2026-10-01', '2026-10-03'))).toBe('scope=human&from=2026-10-01&to=2026-10-03&deck=appa');
    expect(home.withPin(lens, 'deck', 'appa').deck).toBeNull();
  });

  it('reads the lens back as a sentence', () => {
    const lens = home.parseLens('?deck=king-kong&format=duel');
    const summary = { widened: true, kpis: { games: 12, uniqueHumans: 4 }, previous: { games: 0 } };
    expect(home.storySentence(lens, summary)).toBe('Games with a human, last 30 days (widened) with King Kong in 1v1: 12 games, 4 humans.');
  });

  it('offers one way out per active constraint on an empty lens', () => {
    const lens = home.parseLens('?deck=appa&map=soulwood&from=2026-10-01&to=2026-10-02');
    expect(home.emptyOuts(lens).map((o: { label: string }) => o.label)).toEqual([
      'Unpin deck Appa', 'Unpin map Soulwood', 'Include bot-only games', 'Clear date selection',
    ]);
    expect(home.emptyOuts(home.parseLens('?scope=all&range=24h')).map((o: { label: string }) => o.label)).toEqual(['Widen to 30 days']);
  });

  it('links the legacy page with the deck, map and format it understands', () => {
    const lens = home.parseLens('?deck=appa&map=soulwood&format=duel&bot=expert');
    expect(home.legacyHref(lens)).toBe('/legacy?deck=appa&map=soulwood&format=duel');
    expect(home.legacyHref(home.parseLens(''))).toBe('/legacy');
  });
});

describe('landing routes (#98)', () => {
  let server: Server;
  let pool: Pool;
  let baseUrl: string;

  beforeAll(async () => {
    // Static routes never touch the database; this pool never connects.
    pool = new Pool({ connectionString: 'postgres://nobody@127.0.0.1:1/none' });
    server = createServer(createApp({
      repo: new PgTelemetryRepository(pool),
      cpRepo: new ControlPlaneRepository(pool),
      config: {
        telemetrySecret: '',
        accountsReadToken: '',
        allowUnauthenticatedIngest: false,
        bodyLimitBytes: 1024,
        replayBodyLimitBytes: 1024,
        now: () => new Date(),
        discordClientId: '',
        discordClientSecret: '',
        discordRedirectUri: '',
        adminDiscordIds: [],
        secureCookies: false,
      },
    }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await pool.end();
  });

  it('serves the landing at /, the old dashboard at /legacy, and 302s /dashboard to /legacy', async () => {
    const root = await fetch(`${baseUrl}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get('cache-control')).toBe('no-store');
    expect(await root.text()).toBe(await readFile(new URL('../public/home.html', import.meta.url), 'utf8'));

    for (const path of ['/legacy', '/legacy/']) {
      const legacy = await fetch(`${baseUrl}${path}`);
      expect(legacy.status).toBe(200);
      expect(await legacy.text()).toBe(await readFile(new URL('../public/dashboard.html', import.meta.url), 'utf8'));
    }

    for (const path of ['/dashboard', '/dashboard/']) {
      const moved = await fetch(`${baseUrl}${path}?deck=appa&tab=matchups`, { redirect: 'manual' });
      expect(moved.status).toBe(302);
      expect(moved.headers.get('location')).toBe('/legacy?deck=appa&tab=matchups');
    }

    for (const [path, type] of [['/assets/home.js', 'text/javascript'], ['/assets/home.css', 'text/css'], ['/assets/dashboard.js', 'text/javascript']]) {
      const asset = await fetch(`${baseUrl}${path}`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get('content-type')).toContain(type);
    }
  });

  it('leaves the old dashboard byte-for-byte unchanged', async () => {
    const sha = async (path: string) => createHash('sha256').update(await readFile(new URL(path, import.meta.url))).digest('hex');
    expect(await sha('../public/dashboard.html')).toBe('e26c5c0c8c0d68a6b996ec355a1a01646df52ba8f5c174eacd581f621b955d9c');
    expect(await sha('../public/assets/dashboard.js')).toBe('742c7975ae683988ba3ceae75e5f0dc599c0b3329e3f231108a98ec08dc19d29');
  });
});
