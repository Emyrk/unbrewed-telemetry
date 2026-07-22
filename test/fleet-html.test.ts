import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('fleet dashboard', () => {
  it('shows worker session metrics and ships valid inline JavaScript', async () => {
    const html = await readFile(new URL('../public/fleet.html', import.meta.url), 'utf8');

    expect(html).toContain('Fleet Dashboard');
    expect(html).toContain('Session games');
    expect(html).toContain('Throughput');
    expect(html).toContain('Campaign / job');
    expect(html).toContain('Jobs / concurrency');
    expect(html).toContain('Games last hour');
    expect(html).toContain('/v1/admin/fleet?historyHours=24');
    expect(html).toContain('setInterval(tick, 10000)');

    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    expect(scripts).toHaveLength(1);
    const script = scripts[0]?.[1];
    expect(script).toBeDefined();
    expect(() => new Function(script!)).not.toThrow();
  });
});
