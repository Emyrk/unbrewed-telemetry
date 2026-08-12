/**
 * Bot tier decoding (#58) — pure, no DB.
 *
 * The live label inventory is the spec here: `bot_difficulty` is NULL on every
 * live bot seat, so these labels are the only thing standing between an account
 * stats page and one blended "vs bots" row. Each case below is a label that
 * actually appears in prod (counts from the 2026-08-12 survey) or a serving
 * preset the engine emits today.
 */

import { describe, expect, it } from 'vitest';
import { botTier, botTierFromPilot, botTierSql, normalizePilotLabel } from '../src/db/bot-tier.js';

describe('botTierFromPilot', () => {
  it('maps the engine serving presets', () => {
    // ai/registry.ts liveTelemetryPilot: non-search bots label themselves
    // `bot:<difficulty>`, search bots label themselves by algorithm + budget.
    expect(botTierFromPilot('bot:easy')).toBe('easy');
    expect(botTierFromPilot('bot:mc(16,10000ms)')).toBe('medium');
    expect(botTierFromPilot('bot:mc(64,10000ms)')).toBe('hard');
    expect(botTierFromPilot('bot:ismcts(512,10000ms)')).toBe('expert');
  });

  it('maps the legacy greedy-era medium label', () => {
    // Pre engine#263, medium was a non-search bot and said so.
    expect(botTierFromPilot('bot:medium')).toBe('medium');
  });

  it('maps the pre-Road serving clocks to hard', () => {
    // `bot:mc(64, 400ms)` alone is 59299 live seats — the bulk of all history.
    expect(botTierFromPilot('bot:mc(64, 400ms)')).toBe('hard');
    expect(botTierFromPilot('bot:mc(64, 2000ms)')).toBe('hard');
    expect(botTierFromPilot('bot:mc(64, 4000ms)')).toBe('hard');
    expect(botTierFromPilot('bot:mc(64, 600000ms)')).toBe('hard');
    expect(botTierFromPilot('bot:mc')).toBe('hard');
  });

  it('maps the parameterised sim-campaign expert budgets', () => {
    expect(botTierFromPilot('bot:expert(3000,600s)')).toBe('expert');
    expect(botTierFromPilot('bot:expert(1000,600s)')).toBe('expert');
  });

  it('leaves genuinely unmapped labels unknown rather than guessing', () => {
    // Knob-grid sweeps: the tier is a point in a parameter search, not a preset.
    expect(botTierFromPilot('bot:mc(sims-256/eps-0.30/depth-4)')).toBe('unknown');
    expect(botTierFromPilot('bot:mc(sims-32/eps-0.10/depth-2)')).toBe('unknown');
    // Anything that is not a bot label at all, or a bot label we have never seen.
    expect(botTierFromPilot('human')).toBe('unknown');
    expect(botTierFromPilot('bot:brand-new-2027')).toBe('unknown');
    expect(botTierFromPilot('')).toBe('unknown');
    expect(botTierFromPilot(null)).toBe('unknown');
  });

  it('ignores case and whitespace, which the engine has emitted both ways', () => {
    expect(normalizePilotLabel('BOT:MC(64, 400ms)')).toBe('bot:mc(64,400ms)');
    expect(botTierFromPilot('BOT:MC(64, 400MS)')).toBe('hard');
    expect(botTierFromPilot(' bot:easy ')).toBe('easy');
  });

  it('does not let a sims count with a longer prefix match the wrong tier', () => {
    // `bot:mc(640,…)` is not `bot:mc(64,…)` — rules are comma-anchored.
    expect(botTierFromPilot('bot:mc(640,10000ms)')).toBe('unknown');
    expect(botTierFromPilot('bot:mc(160,10000ms)')).toBe('unknown');
  });
});

describe('botTier', () => {
  it('prefers a stamped bot_difficulty over the label', () => {
    // A future engine-side stamp must win: the label is archaeology.
    expect(botTier('expert', 'bot:mc(64, 400ms)')).toBe('expert');
    expect(botTier('  Easy ', 'bot:mc(64, 400ms)')).toBe('easy');
  });

  it('falls back to the label when bot_difficulty is absent — the whole live path', () => {
    expect(botTier(null, 'bot:mc(64, 400ms)')).toBe('hard');
    expect(botTier('', 'bot:ismcts(512,10000ms)')).toBe('expert');
  });
});

describe('botTierSql', () => {
  it('reads the seat columns it is handed', () => {
    const sql = botTierSql('o.pilot', 'o.bot_difficulty');
    expect(sql).toContain('lower(o.pilot)');
    expect(sql).toContain("NULLIF(lower(btrim(o.bot_difficulty)), '')");
    expect(sql).toContain("'unknown'");
  });

  it('emits one branch per rule', () => {
    const sql = botTierSql('pilot', 'bot_difficulty');
    expect(sql).toContain("= 'bot:easy' THEN 'easy'");
    expect(sql).toContain("LIKE 'bot:mc(16,%' THEN 'medium'");
    expect(sql).toContain("LIKE 'bot:ismcts(%' THEN 'expert'");
  });
});
