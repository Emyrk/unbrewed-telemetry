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
    expect(html).toContain('class="campaign-buckets"');
    expect(html).toContain('id="campaign-items"');
    expect(html).toContain('Succeeded');
    expect(html).toContain('Failed');
    expect(html).toContain('Leased');
    expect(html).toContain('Idle');
    expect(html).toContain('/v1/admin/campaign/items');
    expect(html).toContain('pageSize=50');
    expect(html).not.toContain('id="campaign-jobs-json"');
    expect(html).toContain('Save JSON &amp; Requeue');
    expect(html).toContain("api('PATCH', '/v1/admin/campaign'");
    expect(html).toContain('Saving regenerates every unfinished job');

    expect(html).toContain('Priority Queue');
    expect(html).toContain('Completed &amp; Cancelled');
    expect(html).toContain('runs first');
    expect(html).toContain('round robin');
    expect(html).toContain('Change Priorities');
    expect(html).toContain('id="campaign-schedule-controls" style="display:none"');
    expect(html).toContain('Add Sim Lane');
    expect(html).toContain('draggable="true"');
    expect(html).toContain('ondrop="dropCampaign(event,');
    expect(html).toContain('function addCampaignLane(');
    expect(html).toContain('function saveCampaignScheduleEdit(');
    expect(html).not.toContain('Join ↑');
    expect(html).not.toContain('Own tier');
    expect(html).toContain("api('PUT', '/v1/admin/campaign/schedule'");
    expect(html).toContain("campaign.status === 'completed' || campaign.status === 'cancelled'");

    expect(html).toContain('Mark inactive');
    expect(html).toContain('Mark active');
    expect(html).toContain("api('POST', '/v1/admin/campaign/active'");

    expect(html).toContain('data-tab="fleet"');
    expect(html).toContain('id="tab-fleet"');
    expect(html).toContain('id="fleet-dashboard"');
    expect(html).toContain("api('GET', '/v1/admin/fleet?historyHours=24')");
    expect(html).toContain('function renderFleet(data)');
    expect(html).toContain('Jobs / concurrency');
    expect(html).toContain('setInterval(() =>');
    expect(html).not.toContain('<a href="/fleet">Fleet</a>');

    expect(html).toContain('id="toggle-revoked-keys"');
    expect(html).toContain('Show revoked');
    expect(html).toContain('Hide revoked');
    expect(html).toContain('let showRevokedCredentials = false;');
    expect(html).toContain('s.credentials.filter(credential => !credential.revokedAt)');
    expect(html).toContain('function toggleRevokedCredentials()');

    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    expect(scripts).toHaveLength(1);
    const script = scripts[0]?.[1];
    expect(script).toBeDefined();
    expect(() => new Function(script!)).not.toThrow();
  });
});
