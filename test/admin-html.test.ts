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
    expect(html).toContain('id="campaign-swap-starting-player"');
    expect(html).toContain('id="campaign-seats"');
    expect(html).toContain('data-seat-deck');
    expect(html).toContain('data-seat-pilot');
    expect(html).toContain('king-taranis-spice');
    expect(html).toContain('unixNanoString');
    expect(html).toContain('id="campaign-preview"');
    expect(html).toContain('Per-game overrides are available only in Raw JSON mode');

    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    expect(scripts).toHaveLength(1);
    const script = scripts[0]?.[1];
    expect(script).toBeDefined();
    expect(() => new Function(script!)).not.toThrow();
  });
});
