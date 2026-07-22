import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('admin campaign editor', () => {
  it('ships builder and raw JSON modes with valid inline JavaScript', async () => {
    const html = await readFile(new URL('../public/admin.html', import.meta.url), 'utf8');

    expect(html).toContain('id="campaign-mode-builder"');
    expect(html).toContain('id="campaign-mode-raw"');
    expect(html).toContain('id="campaign-game-count"');
    expect(html).toContain('id="campaign-format"');
    expect(html).toContain('id="campaign-maps"');
    expect(html).toContain('id="campaign-maps-all"');
    expect(html).toContain('id="campaign-swap-starting-player"');
    expect(html).toContain('id="campaign-seats"');
    expect(html).toContain('Hero deck pool');
    expect(html).toContain('Pilot pool');
    expect(html).toContain('All registered');
    expect(html).toContain('All bot pilots');
    expect(html).toContain("const campaignPilotValues = ['bot:easy', 'bot:medium', 'bot:hard', 'bot:expert'];");
    expect(html).toContain("const selectedPilots = values.pilots?.length ? values.pilots : ['bot:hard'];");
    expect(html).not.toContain("'bot:expert', 'human'");
    expect(html).toContain('data-seat-deck-options');
    expect(html).toContain('data-seat-pilot-options');
    expect(html).toContain('king-taranis-spice');
    expect(html).toContain('unixNanoString');
    expect(html).toContain('id="campaign-preview"');
    expect(html).toContain('Per-game overrides are available only in Raw JSON mode');

    expect(html).toContain('id="campaign-detail-json"');
    expect(html).toContain('id="campaign-jobs-json"');
    expect(html).toContain('Save JSON &amp; Requeue');
    expect(html).toContain("api('PATCH', '/v1/admin/campaign'");
    expect(html).toContain('Saving regenerates every unfinished job');

    expect(html).toContain('Mark inactive');
    expect(html).toContain('Mark active');
    expect(html).toContain("api('POST', '/v1/admin/campaign/active'");

    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    expect(scripts).toHaveLength(1);
    const script = scripts[0]?.[1];
    expect(script).toBeDefined();
    expect(() => new Function(script!)).not.toThrow();
  });
});
