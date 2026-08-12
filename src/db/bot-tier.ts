/**
 * Bot difficulty tier, derived from the seat's pilot label (#58).
 *
 * `game_seats.bot_difficulty` is the field this *should* come from, but the
 * engine has never stamped it on the live serving path: it is NULL on 100% of
 * live bot seats (~84k rows, verified against prod 2026-08-12). Everything
 * keyed on it therefore collapsed into a single `unknown` bucket.
 *
 * `game_seats.pilot` is the ground truth instead — the engine builds it from
 * the running preset at seat creation (`ai/registry.ts liveTelemetryPilot`), so
 * the tier is encoded in the label. This module owns that decoding, in two
 * forms that must agree: {@link botTierFromPilot} for TypeScript, and
 * {@link botTierSql} for the aggregates that bucket in Postgres. Both are
 * generated from the same {@link BOT_TIER_RULES} table, so a new label is one
 * edit in one place.
 *
 * `bot_difficulty` keeps precedence wherever both are available: a future
 * engine-side stamp (filed separately) should win over label archaeology.
 */

/** The tiers the accounts surface buckets bot opposition into. */
export type BotTier = 'easy' | 'medium' | 'hard' | 'expert' | 'unknown';

/** The bucket for a label no rule claims. Never guessed at. */
export const UNKNOWN_BOT_TIER = 'unknown';

interface BotTierRule {
  /** `exact` matches the whole normalized label; `prefix` matches its start. */
  kind: 'exact' | 'prefix';
  /** Already normalized: lower-case, whitespace stripped. */
  label: string;
  tier: Exclude<BotTier, 'unknown'>;
  /** Why this label means this tier — the audit trail for the mapping. */
  why: string;
}

/**
 * Pilot label → tier, first match wins.
 *
 * Ordered exact-before-prefix on purpose: `bot:mc` alone is a tier, `bot:mc(…)`
 * reads its tier out of the search budget. Labels are compared normalized, so
 * `bot:mc(64, 400ms)` and `bot:mc(64,400ms)` — both live — are one rule.
 *
 * Deliberately *not* covered, and left to `unknown`: the `bot:mc(sims-…/eps-…/
 * depth-…)` knob-grid labels. Those are sim-campaign sweeps whose tier is a
 * point in a parameter search rather than a serving preset; they should never
 * reach a player's account CTE (campaign games are filtered out upstream), and
 * guessing a tier for them would be inventing data.
 */
export const BOT_TIER_RULES: readonly BotTierRule[] = [
  // Non-search bots label themselves `bot:<difficulty>` directly. `bot:medium`
  // is the legacy greedy-era label from before engine#263 moved medium onto MC.
  { kind: 'exact', label: 'bot:easy', tier: 'easy', why: 'randomBot; non-search label is bot:<difficulty>' },
  { kind: 'exact', label: 'bot:medium', tier: 'medium', why: 'legacy greedy-era medium, pre engine#263' },
  { kind: 'exact', label: 'bot:hard', tier: 'hard', why: 'non-search label is bot:<difficulty>' },
  { kind: 'exact', label: 'bot:expert', tier: 'expert', why: 'non-search label is bot:<difficulty>' },
  // Parameterised forms of the same, e.g. the sim-campaign `bot:expert(3000,600s)`
  // budgets. The tier is named in the label; only the budget varies.
  { kind: 'prefix', label: 'bot:easy(', tier: 'easy', why: 'tier named in the label; budget varies' },
  { kind: 'prefix', label: 'bot:medium(', tier: 'medium', why: 'tier named in the label; budget varies' },
  { kind: 'prefix', label: 'bot:hard(', tier: 'hard', why: 'tier named in the label; budget varies' },
  { kind: 'prefix', label: 'bot:expert(', tier: 'expert', why: 'tier named in the label; budget varies' },
  // ISMCTS is only ever served as expert (EXPERT_SERVE_BUDGET).
  { kind: 'prefix', label: 'bot:ismcts(', tier: 'expert', why: 'ISMCTS is the expert preset (EXPERT_SERVE_BUDGET)' },
  // Monte-Carlo serving presets. Since engine#263 the simulation count is the
  // tier: 16 → medium (MEDIUM_SERVE_BUDGET), 64 → hard (HARD_SERVE_BUDGET).
  //
  // The clocked 64-sim labels — `bot:mc(64, 400ms)` (59k rows, the bulk of live
  // history), `(64, 2000ms)`, `(64, 4000ms)`, `(64, 600000ms)` — and the bare
  // `bot:mc` predate the iteration-bound rework; they were all the hard tier's
  // serving configs at the time, so they map to hard rather than to unknown.
  { kind: 'exact', label: 'bot:mc', tier: 'hard', why: 'pre-iteration-bound hard serving config' },
  { kind: 'prefix', label: 'bot:mc(16,', tier: 'medium', why: 'MEDIUM_SERVE_BUDGET is 16 sims (engine#263)' },
  { kind: 'prefix', label: 'bot:mc(64,', tier: 'hard', why: 'HARD_SERVE_BUDGET is 64 sims' },
];

/**
 * Labels are compared case- and whitespace-insensitively: the engine has
 * emitted both `bot:mc(64, 400ms)` and `bot:mc(64,10000ms)`, and the space is
 * formatting, not meaning.
 */
export function normalizePilotLabel(pilot: string): string {
  return pilot.toLowerCase().replace(/\s+/g, '');
}

/** The tier a pilot label encodes, or `unknown` when no rule claims it. */
export function botTierFromPilot(pilot: string | null | undefined): BotTier {
  if (pilot === null || pilot === undefined) return UNKNOWN_BOT_TIER;
  const label = normalizePilotLabel(pilot);
  if (label === '') return UNKNOWN_BOT_TIER;
  for (const rule of BOT_TIER_RULES) {
    const hit = rule.kind === 'exact' ? label === rule.label : label.startsWith(rule.label);
    if (hit) return rule.tier;
  }
  return UNKNOWN_BOT_TIER;
}

/**
 * The tier for one seat, `bot_difficulty` first: a stamped difficulty is what
 * the engine meant, and the label is only the fallback reconstruction of it.
 */
export function botTier(botDifficulty: string | null | undefined, pilot: string | null | undefined): BotTier {
  const stamped = (botDifficulty ?? '').trim().toLowerCase();
  if (stamped !== '') return stamped as BotTier;
  return botTierFromPilot(pilot);
}

/**
 * Rule labels are inlined into SQL literals, so they must not carry a quote or
 * a LIKE wildcard. They are ours, not user input — this is a build-time guard
 * against a careless edit to the table above, not a sanitizer.
 */
function sqlSafeLabel(label: string): string {
  if (!/^[a-z0-9:().,\-/]+$/.test(label)) {
    throw new Error(`bot tier rule label is not SQL-literal safe: ${label}`);
  }
  return label;
}

/**
 * The SQL twin of {@link botTier}: a `CASE` chain over the same rules, in the
 * same order, applied to the same normalization.
 *
 * Generated rather than hand-written so the mapping cannot drift between the
 * two implementations — `test/bot-tier.test.ts` covers the TypeScript one, and
 * the DB-backed accounts tests cover this one against the same labels.
 */
export function botTierSql(pilotExpr: string, botDifficultyExpr: string): string {
  const normalized = `regexp_replace(lower(${pilotExpr}), '\\s', '', 'g')`;
  const branches = BOT_TIER_RULES.map((rule) => {
    const label = sqlSafeLabel(rule.label);
    const test = rule.kind === 'exact' ? `${normalized} = '${label}'` : `${normalized} LIKE '${label}%'`;
    return `           WHEN ${test} THEN '${rule.tier}'`;
  }).join('\n');
  return [
    `COALESCE(`,
    `           NULLIF(lower(btrim(${botDifficultyExpr})), ''),`,
    `           CASE`,
    branches,
    `           END,`,
    `           '${UNKNOWN_BOT_TIER}')`,
  ].join('\n');
}
