/**
 * Static checks for the public Road to Expert+ page (#32): the live-visibility
 * elements, the warming-up treatment, the glossary, and public-safe language.
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const load = () => readFile(new URL('../public/road-to-expert.html', import.meta.url), 'utf8');

describe('road-to-expert page', () => {
  it('ships valid inline JavaScript and keeps the existing poll cadence', async () => {
    const html = await load();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    expect(scripts).toHaveLength(1);
    expect(() => new Function(scripts[0]![1]!)).not.toThrow();
    expect(html).toContain('setInterval(tick, 8000)');
    expect(html).toContain('/v1/sim/public/journey');
  });

  it('renders the four live-visibility elements from journey aggregates', async () => {
    const html = await load();
    // 1. matchup strip + 2. gate chart live inside the card accordion
    expect(html).toContain('matchupStrip');
    expect(html).toContain('gateChart');
    expect(html).toContain('acc-toggle');
    expect(html).toContain('gateSeries');
    // accordions are collapsed by default and re-render must respect openAcc
    expect(html).toContain('const openAcc = new Set()');
    // 3. worker chips read labels + build freshness, never key ids
    expect(html).toContain('j.workers');
    expect(html).toContain('latestBuild');
    expect(html).toContain('heartbeatAgeSeconds');
    expect(html).toContain('no live workers');
    expect(html).not.toMatch(/ubk_/);
    expect(html).not.toContain('credentialId');
    // 4. in-flight pulse on the collapsed face, tolerant of absent checkpoints
    expect(html).toContain('in flight');
    expect(html).toContain('medianDecisions');
    expect(html).toContain('first moves under way');
  });

  it('renders the arm6 serveable-budget sweep, and leaves the existing ladder in place (#39)', async () => {
    const html = await load();
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0]![1]!;
    // Evaluate ONLY the STEPS/ORDER declarations — the rest of the script touches
    // `document` at load time. ORDER drives the rendered card list, and a name
    // missing from STEPS renders nothing (`const meta = STEPS[name]; if (!meta) return ''`).
    const declStart = script.indexOf('const STEPS = {');
    const declEnd = script.indexOf('\n', script.indexOf('const ORDER = ['));
    expect(declStart).toBeGreaterThan(-1);
    expect(declEnd).toBeGreaterThan(declStart);
    const decls = script.slice(declStart, declEnd);
    const [steps, order] = new Function(`${decls}; return [STEPS, ORDER];`)() as [Record<string, unknown>, string[]];
    expect(order).toEqual(['grid', 'arm1', 'arm2', 'arm3', 'arm5', 'mirror', 'arm6a', 'arm6b', 'arm6c', 'cost']);
    for (const name of order) {
      expect(steps[name], `ORDER lists ${name} but STEPS has no card for it`).toBeTruthy();
    }
    for (const name of ['arm6a', 'arm6b', 'arm6c']) {
      expect((steps[name] as { title: string }).title).toMatch(/serveable budget/);
    }
    // The cost step stays — its instrumentation is a separate follow-up.
    expect(order).toContain('cost');
  });

  it('applies the warming-up treatment below the verdict threshold', async () => {
    const html = await load();
    expect(html).toContain('warming up · n=');
    expect(html).toContain('MIN_VERDICT_GAMES = 50');
    expect(html).toContain('j.minVerdictGames');
  });

  it('has a glossary entry for every term used on the page, grouped and linkable', async () => {
    const html = await load();
    expect(html).toContain('What do these terms mean?');
    for (const group of ['The bots', 'The experiments', 'The statistics']) {
      expect(html).toContain(`>${group}<`);
    }
    const entries = [
      'g-ismcts', 'g-flat-mc', 'g-hard-64', 'g-playouts',
      'g-arm', 'g-gate', 'g-knob-grid', 'g-compute-parity', 'g-wall-clock',
      'g-mirror', 'g-pairing', 'g-seat-bias',
      'g-win-rate', 'g-interval', 'g-exclude-50', 'g-warming-up', 'g-in-flight', 'g-decisions',
    ];
    for (const id of entries) {
      expect(html, `missing glossary entry #${id}`).toContain(`id="${id}"`);
    }
    // every first-use term link points at an existing entry
    const links = [...html.matchAll(/class="term" href="#([a-z0-9-]+)"/g)].map((m) => m[1]!);
    expect(links.length).toBeGreaterThan(0);
    for (const target of links) {
      expect(entries, `term link #${target} has no glossary entry`).toContain(target);
    }
  });
});
