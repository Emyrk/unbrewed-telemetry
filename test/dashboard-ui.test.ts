import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('balance dashboard format and pilot controls', () => {
  it('defaults to Duel and reserves unsupported formats for coming-soon pages', async () => {
    const script = await readFile(new URL('../public/assets/dashboard.js', import.meta.url), 'utf8');

    expect(script).toContain("const DEFAULT_FORMAT = 'duel';");
    expect(script).toContain("['team-2v2', '2v2 Teams']");
    expect(script).toContain("['ffa-3', '3 FFA']");
    expect(script).toContain('function renderComingSoonFormat()');
    expect(script).toContain("state.format === DEFAULT_FORMAT ? DUEL_TABS : []");
    expect(script).not.toContain("['formats', 'Formats']");
    expect(script).not.toContain("['synergy', '2v2 Synergy']");
  });

  it('uses an allow-list multi-select defaulted to the Monte Carlo pilot', async () => {
    const script = await readFile(new URL('../public/assets/dashboard.js', import.meta.url), 'utf8');

    expect(script).toContain("const DEFAULT_INCLUDED_PILOTS = new Set(['bot:mc(64,400ms)']);");
    expect(script).toContain("params.append('pilot', pilot)");
    expect(script).toContain('data-hero-pilot');
    expect(script).toContain('data-hero-vs-pilot');
    expect(script).toContain('Any allowed pilot');
    expect(script).toContain('data-pilot-search');
    expect(script).toContain('pilot-option-count');
    expect(script).toContain('gameCounts');
    expect(script).toContain('function scheduleDashboardLoad()');
    expect(script).toContain('FILTER_DEBOUNCE_MS');
    expect(script).toContain('allPilots = (json.pilots || []).map((row) => row.pilot)');
    expect(script).toContain('!state.hasExplicitExclusions && allPilots.length === 0');
    expect(script).toContain('return [...DEFAULT_INCLUDED_PILOTS]');
    expect(script).toContain('if (!bootstrappingDefaultPilots)');
    expect(script).toContain("params.append('opponentPilotAllowed', pilot)");
    expect(script).toContain('...allowedPilots().map((pilot)');
  });
});
