import { describe, expect, it } from 'vitest';
import { lensWindow, parseLens, previousWindow } from '../src/stats/lens.js';
import { balanceFlag } from '../src/stats/home-summary.js';

const parse = (query: string) => parseLens(new URLSearchParams(query));

describe('parseLens (#97)', () => {
  it('defaults to the human scope over the last 7 days with nothing pinned', () => {
    expect(parse('')).toEqual({
      ok: true,
      lens: {
        scope: 'human', range: '7d', from: null, to: null,
        deck: null, vs: null, bot: null, ver: null, map: null, format: null, player: null,
      },
    });
  });

  it('reads every lens key, treats blanks as absent and ignores client-only keys', () => {
    expect(parse('scope=all&range=30d&deck=appa&vs=taranis&bot=expert&ver=expert:v1:rc'
      + '&map=soulwood&player=p-1&tab=patterns&focus=deck:appa&map2=x&format= ')).toEqual({
      ok: true,
      lens: {
        scope: 'all', range: '30d', from: null, to: null,
        deck: 'appa', vs: 'taranis', bot: 'expert', ver: { botId: 'expert', botVersion: 'v1:rc' },
        map: 'soulwood', format: null, player: 'p-1',
      },
    });
  });

  it('accepts a from/to day range in place of range', () => {
    const result = parse('from=2026-07-01&to=2026-07-14');
    expect(result.ok && result.lens).toMatchObject({ range: null, from: '2026-07-01', to: '2026-07-14' });
  });

  it.each([
    ['scope=bots', 'scope'],
    ['range=90d', 'range'],
    ['range=7d&from=2026-07-01&to=2026-07-02', 'range'],
    ['to=2026-07-02', 'from'],
    ['from=2026-07-01', 'to'],
    ['from=2026-02-30&to=2026-03-01', 'from'],
    ['from=2026-07-01&to=07/02/2026', 'to'],
    ['from=2026-07-10&to=2026-07-01', 'to'],
    ['from=2025-01-01&to=2026-07-01', 'to'],
    ['ver=expert', 'ver'],
    ['ver=:v1', 'ver'],
    ['ver=expert:', 'ver'],
    ['deck=a&deck=b', 'deck'],
    ['player=%00x', 'player'],
    [`map=${'m'.repeat(201)}`, 'map'],
  ])('rejects %s naming %s', (query, key) => {
    const result = parse(query);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.key).toBe(key);
  });
});

describe('lens windows', () => {
  const now = new Date('2026-07-20T12:00:00.000Z');

  it('ends a trailing range at now and shifts it back once for the previous period', () => {
    const lens = parse('range=24h');
    if (!lens.ok) throw new Error('parse failed');
    const window = lensWindow(lens.lens, now);
    expect(window).toEqual({ from: new Date('2026-07-19T12:00:00.000Z'), to: now });
    expect(previousWindow(window)).toEqual({ from: new Date('2026-07-18T12:00:00.000Z'), to: window.from });
  });

  it('covers whole UTC days, both ends inclusive', () => {
    const lens = parse('from=2026-07-01&to=2026-07-03');
    if (!lens.ok) throw new Error('parse failed');
    const window = lensWindow(lens.lens, now);
    expect(window).toEqual({ from: new Date('2026-07-01T00:00:00.000Z'), to: new Date('2026-07-04T00:00:00.000Z') });
    expect(previousWindow(window).from).toEqual(new Date('2026-06-28T00:00:00.000Z'));
  });
});

describe('balanceFlag', () => {
  it('needs n >= 30', () => {
    expect(balanceFlag(29, 29)).toBeNull();
    expect(balanceFlag(0, 29)).toBeNull();
    expect(balanceFlag(30, 30)).toBe('OVER');
    expect(balanceFlag(0, 30)).toBe('UNDER');
  });

  it('flags only when the 95% Wilson band clears 45–55', () => {
    // 22/30: band ≈ 0.554–0.858, clears 55. 21/30: band ≈ 0.521–0.833, does not.
    expect(balanceFlag(22, 30)).toBe('OVER');
    expect(balanceFlag(21, 30)).toBeNull();
    expect(balanceFlag(8, 30)).toBe('UNDER');
    expect(balanceFlag(9, 30)).toBeNull();
    expect(balanceFlag(500, 1000)).toBeNull();
  });
});
